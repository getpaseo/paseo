import { AppRegistry } from "react-native";

AppRegistry.registerComponent("Paseo", () => () => null);

// The native test supplies a loopback server before loading this bundle.
const base = globalThis.__webSocketRegressionUrl;
async function connect(path, expectedCode, localClose = false) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}/${path}`);
    const timeout = setTimeout(() => reject(new Error(`${path}: timed out`)), 5000);
    let echoed = false;
    socket.addEventListener("open", () => socket.send("native websocket regression"));
    socket.addEventListener("message", (event) => {
      echoed = event.data === "native websocket regression";
      if (localClose) socket.close(1000, "client done");
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      if (event.code !== expectedCode || (expectedCode === 1000 && !echoed)) {
        reject(new Error(`${path}: code=${event.code}, echoed=${echoed}`));
      } else {
        resolve();
      }
    });
  });
}

async function run() {
  // Keep retrying through the real RN WebSocket API. Before the fix, native
  // clients survived terminal events and exhausted the Mac's descriptor limit.
  for (const [path, code, localClose] of [
    ["reject", 1006, false],
    ["remote-close", 1000, false],
    ["local-close", 1000, true],
  ]) {
    for (let attempt = 0; attempt < 128; attempt++) {
      await connect(path, code, localClose);
    }
    console.log(`WEBSOCKET_REGRESSION_PASS ${path}`);
  }
  console.log("WEBSOCKET_REGRESSION_COMPLETE");
}
setTimeout(() => {
  run().catch((error) => console.error(`WEBSOCKET_REGRESSION_FAIL ${error.message}`));
}, 0);
