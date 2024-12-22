// Listening server to route incoming connections to the appropriate server
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";
import transmit from "../../modules/transmitter";

const shardServers = new Map<string, WebSocket>();
const clientConnections = new Map<string, WebSocket>();

const socket = Bun.serve<any>({
  fetch(req, Server) {
    const id = Bun.randomUUIDv7();
    const success = Server.upgrade(req, { data: { id } });
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  websocket: {
    message(ws, message: Buffer) {
      // Check if the message is a buffer 
      if (!Buffer.isBuffer(message)) return ws.close(1000, "Invalid packet received");
      const data = tryParsePacket(message.toString()) as any;
      if (!data) return ws.close(1000, "Invalid packet received");
      // Check if the key was passed
      if (!data.key) {
        ws.send(
          transmit.encode(
            JSON.stringify({
              type: "AUTH_ERROR",
              data: "No authentication key was provided",
              key: null,
            })
          )
        );
        ws.close();
        console.log(`Shard server ${ws.data.id} disconnected. Reason: No authentication key was provided`);
        return;
      }

      // Check if the key is valid
      if (decrypt(data.key) !== process.env.KEY) {
        ws.send(
          transmit.encode(
            JSON.stringify({
              type: "AUTH_ERROR",
              data: "Invalid authentication key",
              key: null,
            })
          )
        );
        ws.close(1000, "Invalid authentication key");
        return;
      }

      // Check if the message is a proxy message
      if (data.mode === "PROXY") {
        const id = data?.data?.id || null;
        if (!id) return ws.close(1000, "No server ID provided");
        // Distribute the message back to the client that sent it
        const client = clientConnections.get(id);
        if (!client) return ws.close(1000, "Client not found");
        // Strip the private key from the data
        data.key = undefined;
        client.send(transmit.encode(JSON.stringify(data)));
        return;
      }

      // Add the shard server to the list of servers if it doesn't exist
      if (!shardServers.has(ws.data.id)) {
        shardServers.set(ws.data.id, ws as unknown as WebSocket);
        const ip = ws.remoteAddress;
        console.log(`Shard server ${ws.data.id} connected @ ${ip}`);
        ws.send(
          transmit.encode(
            JSON.stringify({
              type: "AUTH_SUCCESS",
              data: "Shard server has been authenticated",
              id: ws.data.id,
              key: encrypt(process.env.KEY as string),
            })
          )
        );
      }
    },
    close(ws, code, reason) {
      reason = reason || "No reason provided";
      console.log(`Shard server ${ws.data.id} disconnected. Code: ${code} Reason: ${reason}`);
      // Remove the shard server from the list of servers
      shardServers.delete(ws.data.id);
    },
  },
  port: 3000,
});
console.log(`Realm server is running at ${socket.url}`);

let lastChoice: WebSocket | null = null;
function distribute() : WebSocket | null {
  let chosenServer: WebSocket | null = null;
  for (const shardServer of shardServers.values()) {
    // Round robin the servers
    if (shardServer === lastChoice) continue;
    chosenServer = shardServer;
    lastChoice = shardServer;
    break;
  }
  return chosenServer;
}

const server = Bun.serve<any>({
  fetch(req, Server) {
    const id = Bun.randomUUIDv7();
    const success = Server.upgrade(req, { data: { id } });
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  websocket: {
    open(ws) {
      // Add the client connection to the list of connections
      clientConnections.set(ws.data.id, ws as unknown as WebSocket);
    },
    message(ws, message: Buffer) {
      // Check if the message is a buffer 
      if (!Buffer.isBuffer(message)) return ws.close(1000, "Invalid packet received");
      const data = tryParsePacket(message.toString()) as any;
      if (!data) return ws.close(1000, "Invalid packet received");

      // Distribute the message to the chosen server
      const loadBalancer = distribute() as unknown as WebSocket;
      if (!loadBalancer) return ws.close(1000, "No servers available");
      // Add a key to the message
      data.key = encrypt(process.env.KEY as string);
      data.mode = "DISTRIBUTED_TASK";
      data.id = ws.data.id;
      // Send the message to the chosen server
      loadBalancer.send(transmit.encode(JSON.stringify(data)));
    },
    close(ws, code, reason) {
      reason = reason || "No reason provided";
      console.log(`Client ${ws.data.id} disconnected. Code: ${code} Reason: ${reason}`);
      // Remove the client connection from the list of connections
      clientConnections.delete(ws.data.id);
    },
  },
  port: 3001,
})
console.log(`Load balancer is running at ${server.url}`);


function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    console.log(e as string);
    return undefined;
  }
}