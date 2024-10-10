// Listening server to route incoming connections to the appropriate server
import crypto from "crypto";
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";

const childServers = new Map<string, WebSocket>();
const socket = Bun.serve<any>({
  fetch(req, Server) {
    const id = crypto.randomBytes(32).toString("hex");
    const stats = {
      freeRam: null,
      cpuUsage: null,
    };
    const success = Server.upgrade(req, { data: { id, stats } });
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  websocket: {
    open(ws) {},
    message(ws, message: string) {
      // Check if the key was passed
      let key = JSON.parse(message).key || null;
      if (!key) {
        ws.send(
          JSON.stringify({
            type: "AUTH_ERROR",
            data: "No authentication key was provided",
            key: null,
          })
        );
        ws.close();
      }

      if (decrypt(key) !== process.env.KEY) {
        ws.send(
          JSON.stringify({
            type: "AUTH_ERROR",
            data: "Invalid authentication key",
            key: null,
          })
        );
        ws.close();
      }

      // Add the child server to the list of servers if it doesn't exist
      if (!childServers.has(ws.data.id)) {
        childServers.set(ws.data.id, ws as unknown as WebSocket);
        const ip = JSON.parse(message).data || null;
        console.log(`Child server ${ws.data.id} connected @ ${ip}`);
        ws.send(
          JSON.stringify({
            type: "AUTH_SUCCESS",
            data: "Child server has been authenticated",
            id: ws.data.id,
            key: encrypt(process.env.KEY as string),
          })
        );
      }

      try {
        let stats = JSON.parse(message).stats;
        ws.data.stats = stats;
      } catch {
        console.log("Error parsing stats from child server");
      }

      const data = JSON.parse(message);
      //console.log(data);
    },
    close(ws) {
      console.log(`Child server ${ws.data.id} disconnected`);
      // Remove the child server from the list of servers
      childServers.delete(ws.data.id);
    },
  },
});

function distribute() {
  let chosenServer: WebSocket | null = null;
  for (const childServer of childServers.values()) {
    const stats = (childServer as WebSocket & { data: any })?.data?.stats;
    if (!stats?.cpuUsage || !stats?.freeRam) continue;
    // Set the first server as the chosen server if it hasn't been set yet
    if (!chosenServer) {
      chosenServer = childServer;
    }

    // Choose the server with the lowest CPU usage and the highest free RAM
    // Compare the CPU usage and free RAM of the current server with the chosen server
    // Keep searching for the server with the lowest CPU usage and the highest free RAM
    if (
      stats.cpuUsage <
        (chosenServer as WebSocket & { data: any }).data.stats.cpuUsage &&
      stats.freeRam >
        (chosenServer as WebSocket & { data: any }).data.stats.freeRam
    ) {
      chosenServer = childServer;
    } else if (
      stats.cpuUsage ===
        (chosenServer as WebSocket & { data: any }).data.stats.cpuUsage &&
      stats.freeRam >
        (chosenServer as WebSocket & { data: any }).data.stats.freeRam
    ) {
      chosenServer = childServer;
    } else if (
      stats.cpuUsage <
        (chosenServer as WebSocket & { data: any }).data.stats.cpuUsage &&
      stats.freeRam ===
        (chosenServer as WebSocket & { data: any }).data.stats.freeRam
    ) {
      chosenServer = childServer;
    }
  }
  return chosenServer;
}

setInterval(() => {
  const loadBalancer = distribute() as unknown as WebSocket;

  if (loadBalancer) {
    loadBalancer.send(
      JSON.stringify({
        data: "DISTRIBUTED TASK",
        key: encrypt(process.env.KEY as string),
      })
    );
  }
}, 1000);

console.log(`Master server is running at ${socket.url}`);
