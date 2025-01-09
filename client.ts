import os from "os";
import cluster from "cluster";
import transmit from "./modules/transmitter";

const workers = os.availableParallelism();

if (cluster.isPrimary) {
    let messageCounts: { [key: number]: number } = {};

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
} else {
    const socket = new WebSocket("ws://127.0.0.1:3001");
    let messageCount = 0;

    let batchCount = 1000;
    socket.onopen = () => {
        setInterval(() => {
            for (let i = 0; i < batchCount; i++) {
                socket.send(transmit.encode(JSON.stringify({ type: "PING" })));
                messageCount++;
            }
        }, 1);
    };

    socket.onmessage = (event) => {
        if (!Buffer.isBuffer(event.data)) return socket.close(1000, "Invalid packet received");
        const data = tryParsePacket(event.data.toString()) as any;
        if (!data) return socket.close(1000, "Invalid packet received");
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

function tryParsePacket(data: any) {
    try {
        if (typeof data !== "string") return undefined;
        return JSON.parse(data.toString());
    } catch (e) {
        console.log(e as string);
        return undefined;
    }
}