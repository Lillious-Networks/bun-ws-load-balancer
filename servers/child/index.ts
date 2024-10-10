// Child server to handle incoming connections from the master server
import os from "os";
import encrypt from "../../modules/encrypt";
import decrypt from "../../modules/decrypt";
import child_process from "child_process";
const socket = new WebSocket("ws://127.0.0.1:3000");

function getCPUUsage() {
  if (os.platform() === "win32") {
    const result = parseInt(
      child_process
        .execSync("wmic cpu get loadpercentage")
        .toString()
        .split("\n")[1]
    );
    return result;
  } else {
    return Math.round(Number(os.loadavg()[0]));
  }
}

function getIpAddress() {
  const process = child_process.spawnSync("curl", ["ifconfig.me"]);
  return process.stdout.toString();
}

socket.onopen = () => {
  socket.send(
    JSON.stringify({
      data: getIpAddress(),
      key: encrypt(process.env.KEY as string),
    })
  );

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (!data?.key) {
      throw new Error("No key was provided!");
    }

    if (decrypt(data.key) !== process.env.KEY) {
      throw new Error("Invalid key provided!");
    }

    if (data.type === "AUTH_SUCCESS") {
      console.log("Connection established with the master server");
    }

    if (data.type === "AUTH_ERROR") {
      throw new Error(data.data);
    }
  };

  socket.onclose = (ws) => {
    console.log(
      `Connection closed with code ${ws.code} and reason ${ws.reason}`
    );
    process.exit(0);
  };

  setInterval(() => {
    socket.send(
      JSON.stringify({
        stats: {
          freeRam: os.freemem(),
          cpuUsage: getCPUUsage() || 0,
        },
        data: null,
        key: encrypt(process.env.KEY as string),
      })
    );
  }, 100);
};

setTimeout(() => {
  if (socket.readyState === 3) {
    throw new Error("Unable to connect to the master server!");
  }
}, 5000);
