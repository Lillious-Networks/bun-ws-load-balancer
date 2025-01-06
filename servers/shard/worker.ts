// Shard service to handle incoming connections from the realm server
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";
import transmit from "../../modules/transmitter";
const host = process.env.HOST || "localhost";
const realmPort = process.env.REALM_PORT || 3000;
const socket = new WebSocket(`ws://${host}:${realmPort}`);

socket.onopen = async () => {
  socket.send(
    transmit.encode(
      JSON.stringify({
        data: null,
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

function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    console.log(e as string);
    return undefined;
  }
}