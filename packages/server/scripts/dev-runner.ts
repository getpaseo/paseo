import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const serverEntry = fileURLToPath(
  new URL("../src/server/index.ts", import.meta.url)
);

let child: ChildProcess | null = null;
let restarting = false;

function spawnServer() {
  child = fork(serverEntry, {
    stdio: "inherit",
    env: process.env,
    execArgv: ["--import", "tsx"],
  });

  child.on("message", (msg: any) => {
    if (msg?.type === "paseo:restart") {
      restartServer();
    }
  });

  child.on("exit", (code, signal) => {
    if (restarting) {
      restarting = false;
      spawnServer();
      return;
    }

    const exitDescriptor =
      signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
    console.warn(`[DevRunner] Server exited (${exitDescriptor}). Shutting down.`);
    process.exit(typeof code === "number" ? code : 0);
  });
}

function restartServer() {
  if (!child || restarting) {
    return;
  }

  restarting = true;
  console.warn("[DevRunner] Restart requested. Stopping current server...");
  child.kill("SIGTERM");
}

function forwardSignal(signal: NodeJS.Signals) {
  if (!child) {
    process.exit(0);
  }
  child.kill(signal);
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

console.log("[DevRunner] Starting server with tsx (explicit restarts only)");
spawnServer();
