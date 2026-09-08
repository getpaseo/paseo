import process from "node:process";
import { WebSocket } from "ws";

const [, , metroPortArgument, durationArgument, appId] = process.argv;
const metroPort = Number(metroPortArgument);
const duration = Number(durationArgument);
const targets = await fetch(`http://127.0.0.1:${metroPort}/json/list`).then((response) =>
  response.json(),
);
const target = targets.find((candidate) => candidate.appId === appId);
if (!target) throw new Error(`Missing Hermes target for ${appId}`);

await new Promise((resolve, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const timeout = setTimeout(() => reject(new Error("Hermes stall timed out")), duration + 5000);
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: `(() => { const deadline = Date.now() + ${duration}; while (Date.now() < deadline) {} })()`,
        },
      }),
    );
  });
  socket.on("message", (message) => {
    const response = JSON.parse(message.toString());
    if (response.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    resolve();
  });
  socket.on("error", reject);
});
