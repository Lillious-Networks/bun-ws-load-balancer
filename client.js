import os from "os";
import cluster from "cluster";
const transmit = {
    encode(data) {
      const encoder = new TextEncoder();
      return encoder.encode(data);
    },
  };

const workers = os.availableParallelism();

if (cluster.isPrimary) {
    let messageCounts = {};

    console.log(`Primary client started with ${workers} workers`);
    for (let i = 0; i < workers; i++) {
        const worker = cluster.fork();

        if (worker.process.pid !== undefined) {
            messageCounts[worker.process.pid] = 0;
        }

        worker.on("message", (msg) => {
            if (msg.type === "MESSAGE_COUNT") {
                messageCounts[msg.pid] = msg.count;
            }
        });
    }

    setInterval(() => {
        if (Object.keys(cluster.workers).length === 0) {
            process.exit(0);
        }
        const totalMessages = Object.values(messageCounts).reduce((sum, count) => sum + count, 0);
        console.log(`Total messages per second: ${totalMessages}`);
    }, 1000);
} else {
    const socket = new WebSocket("ws://127.0.0.1:3001");
    let messageCount = 0;

    socket.onopen = () => {
        setInterval(() => {
            socket.send(transmit.encode(
                JSON.stringify({
                    type: "PING",
                    data: {
                        message: null,
                    },
                })
            ));
            messageCount++;
        }, 0);
    };

    socket.onmessage = (event) => {
        return;
    };

    socket.onclose = () => {
        console.log("Connection closed");
        process.exit(0);
    };

    setInterval(() => {
        process.send?.({
            type: "MESSAGE_COUNT",
            pid: process.pid,
            count: messageCount,
        });
        messageCount = 0;
    }, 1000);
}

function tryParsePacket(data) {
    try {
        if (Object.keys(data).length === 0) return undefined;
        return JSON.parse(data.toString());
    } catch (e) {
        console.log(e);
        return undefined;
    }
}