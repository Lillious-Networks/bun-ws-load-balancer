// Listening server to route incoming connections to the appropriate server
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";
import transmit from "../../modules/transmitter";
// Realm message queue for dropped messages so they can be retried as a batch
const realmMessageQueue: Buffer[] = [];
let realmCanSend = true;
// Proxy message queue for dropped messages so they can be retried as a batch
const proxyMessageQueue: Buffer[] = [];
let proxyCanSend = true;
const shardServers = new Map<string, WebSocket>();
const clientConnections = new Map<string, WebSocket>();
const ClientRateLimit = [] as ClientRateLimit[];
const RateLimitOptions: RateLimitOptions = {
  // Maximum amount of requests
  maxRequests: 2000,
  // Time in milliseconds to remove rate limiting
  time: 2000,
  // Maximum window time in milliseconds
  maxWindowTime: 1000,
};

// Proxy WebSocket server to relay messages to the appropriate client
const socket = Bun.serve<any>({
  fetch(req, Server) {
    const id = Bun.randomUUIDv7();
    const success = Server.upgrade(req, { data: { id } });
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  websocket: {
    perMessageDeflate: true,
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
        ws.close(1000, "No authentication key was provided");
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
        if (!client) return;
        // Strip the private key from the data
        data.key = undefined;
        const result = client.send(transmit.encode(JSON.stringify(data)));
        if ((Number(result) == -1) || !proxyCanSend) {
          // Prevent the server from sending more messages until the current message is sent
          proxyCanSend = false;
          // Add the dropped data to the queue
          proxyMessageQueue.push(data);
        }
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
    drain(ws) {
      console.log(`Shard server ${ws.data.id} is draining backpressure`);
      // Retry sending the messages that were dropped due to the server being unavailable at the time
      proxyMessageQueue.forEach((message) => ws.send(transmit.encode(message.toString())));
      proxyMessageQueue.length = 0;
      // Set the server to be able to send messages again
      proxyCanSend = true;
    },
  },
  port: process.env.REALM_PORT || 3000,
});

console.log(`Realm server is running at ${socket.url}`);

let lastChoice: WebSocket | null = null;
function distribute(): WebSocket | null {
  const servers = Array.from(shardServers.values());
  if (servers.length === 0) return null;
  // Find the index of the last chosen server
  const lastIndex = lastChoice ? servers.indexOf(lastChoice) : -1;
  // Choose the next server in a round-robin fashion
  const nextIndex = (lastIndex + 1) % servers.length;
  lastChoice = servers[nextIndex];

  return lastChoice;
}

// Load balancer to distribute messages to the appropriate server
const server = Bun.serve<any>({
  fetch(req, Server) {
    const id = Bun.randomUUIDv7();
    const success = Server.upgrade(req, { data: { id } });
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      // Add the client connection to the list of connections
      clientConnections.set(ws.data.id, ws as unknown as WebSocket);
      ClientRateLimit.push({
        id: ws.data.id,
        requests: 0,
        rateLimited: false,
        time: null,
        windowTime: 0,
      });

      setInterval(() => {
        const index = ClientRateLimit.findIndex(
          (client) => client.id === ws.data.id
        );
        if (index === -1) return;
        const client = ClientRateLimit[index];
        // Return if the client is rate limited
        if (client.rateLimited) {
          client.requests = 0;
          client.windowTime = 0;
          return;
        }
        client.windowTime += 1000;
        if (client.windowTime > RateLimitOptions.maxWindowTime) {
          client.requests = 0;
          client.windowTime = 0;
        }
      }, 1000);
    },
    message(ws, message: Buffer) {
      // Check if the message is a buffer 
      if (!Buffer.isBuffer(message)) return ws.close(1000, "Invalid packet received");
      const data = tryParsePacket(message.toString()) as any;
      if (!data) return ws.close(1000, "Invalid packet received");
      for (const client of ClientRateLimit) {
        // Return if the client is rate limited
        if (client.rateLimited) return;
        if (client.id === ws.data.id) {
          // Update the client requests count +1
          client.requests++;
          // Check if the client has reached the rate limit
          if (client.requests >= RateLimitOptions.maxRequests) {
            client.rateLimited = true;
            client.time = Date.now();
            console.log(`Client with id: ${ws.data.id} is rate limited`);
            ws.send(
              transmit.encode(
                JSON.stringify({ type: "RATE_LIMITED", data: "Rate limited" })
              )
            );
            return;
          }
        }
      }
      // Distribute the message to the chosen server
      const loadBalancer = distribute() as unknown as WebSocket;
      if (!loadBalancer) return ws.close(1000, "No servers available");
      // Add a key to the message
      data.key = encrypt(process.env.KEY as string);
      data.mode = "DISTRIBUTED_TASK";
      data.id = ws.data.id;
      // Send the message to the chosen server
      const result = loadBalancer.send(transmit.encode(JSON.stringify(data)));
      // Message was not sent, send it off to retry
      if ((Number(result) == -1) || !realmCanSend) {
        // Prevent the server from sending more messages until the current message is sent
        realmCanSend = false;
        // Add the dropped data to the queue
        realmMessageQueue.push(data);
        console.log(`Buffering message for client ${ws.data.id}`);
        return;
      }
    },
    close(ws, code, reason) {
      reason = reason || "No reason provided";
      console.log(`Client ${ws.data.id} disconnected. Code: ${code} Reason: ${reason}`);
      // Remove the client connection from the list of connections
      clientConnections.delete(ws.data.id);
      // Remove the client from the rate limit list
      const index = ClientRateLimit.findIndex((client) => client.id === ws.data.id);
      if (index !== -1) {
        ClientRateLimit.splice(index, 1);
      }
    },
    drain(ws) {
      console.log(`Load balancer is draining backpressure`);
      // Retry sending the messages that were dropped due to the server being unavailable at the time
      realmMessageQueue.forEach((message) => ws.send(transmit.encode(message.toString())));
      realmMessageQueue.length = 0;
      // Set the server to be able to send messages again
      realmCanSend = true;
    },
  },
  port: process.env.SHARD_PORT || 3001,
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

// Remove the rate limit from the client after the time has passed
setInterval(() => {
  if (ClientRateLimit.length < 1) return;
  const timestamp = Date.now();
  for (let i = 0; i < ClientRateLimit.length; i++) {
    const client = ClientRateLimit[i];
    if (client.rateLimited && client.time) {
      if (timestamp - client.time! > RateLimitOptions.time) {
        client.rateLimited = false;
        client.requests = 0;
        client.time = null;
        console.log(`Client with id: ${client.id} is no longer rate limited`);
      }
    }
  }
}, RateLimitOptions.time);