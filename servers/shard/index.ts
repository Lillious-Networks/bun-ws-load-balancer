// Shard service to handle incoming connections from the realm server
import os from "os";
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";
import { $ } from "bun";
import transmit from "../../modules/transmitter";
const workers = os.availableParallelism();
import cluster from "cluster";

if (cluster.isPrimary) {
  console.log(`Primary shard service started with ${workers} workers`);
  for (let i = 0; i < workers; i++) {
    cluster.fork();
  }
  cluster.on("exit", (worker, code, signal) => {
    console.log(`Shard worker ${worker.process.pid} died with code: ${code} and signal: ${signal}`);
    console.log("Restarting worker...");
    cluster.fork();
  });
} else {
  const socket = new WebSocket("ws://127.0.0.1:3000");

  async function getCPUUsage() {
    if (os.platform() === "win32") {
      const result = await $`wmic cpu get loadpercentage`.text();
      return result.toString().split("\n")[1];
    } else {
      return Math.round(Number(os.loadavg()[0]));
    }
  }
  
  async function getIpAddress() {
    const result = await $`curl ifconfig.me`.text();
    return result.toString();
  }
  
  socket.onopen = async () => {
    socket.send(
      transmit.encode(
        JSON.stringify({
          data: null,
          ip: await getIpAddress(),
          key: encrypt(process.env.KEY as string),
        })
      )
    );
  
    socket.onmessage = (event: any) => {
      if (!Buffer.isBuffer(event.data)) return socket.close(1000, "Invalid packet received");
      const data = tryParsePacket(event.data.toString()) as any;
      if (!data) return socket.close(1000, "Invalid packet received");
      if (!data?.key) {
        socket.close(1000, "Invalid or no key provided");
        process.exit(0);
      }
  
      if (decrypt(data.key) !== process.env.KEY) {
        socket.close(1000, "Invalid key provided");
        process.exit(0);
      }
  
      if (data.type === "AUTH_SUCCESS") {
        console.log(`Shard service worker connected to the realm server with id: ${data.id}`);
      }
  
      if (data.type === "AUTH_ERROR") {
        socket.close(1000, 'Invalid key provided');
        process.exit(0);
      }
  
      // Proxy the task to the realm server
      if (data.mode === "DISTRIBUTED_TASK") {
        console.log(`Received task: ${data.type} from the realm server for client ${data.id}`);
        // Strip the original key from the data so we can re-encrypt it to ensure integrity
        data.key = undefined;
        switch (data.type) {
          case "PING": {
            socket.send(transmit.encode(
              JSON.stringify({
                mode: "PROXY",
                data,
                key: encrypt(process.env.KEY as string)
              })
            ));
            break;
          }
          default:
            console.log(`Unknown task type: ${data.type || "Unknown"}`);
            break;
        }
      }
    };
  
    socket.onclose = (ws) => {
      let reason = ws.reason || "No reason provided";
      console.log(`Disconnected - Code: ${ws.code} Reason: ${reason}`);
      process.exit(0);
    };
  
    setInterval(async () => {
      socket.send(
        transmit.encode(
          JSON.stringify({
            stats: {
              freeRam: os.freemem(),
              cpuUsage: await getCPUUsage() || 0,
            },
            data: null,
            key: encrypt(process.env.KEY as string),
          })
        )
      );
    }, 5000);
  };
  
  setTimeout(() => {
    if (socket.readyState === 3) {
      socket.close(1000, "Unable to connect to the realm server");
      process.exit(0);
    }
  }, 5000);
}

function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    console.log(e as string);
    return undefined;
  }
}