import { fork, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const serverEntry = fileURLToPath(
  new URL("../src/server/index.ts", import.meta.url)
);

let child: ChildProcess | null = null;
let restarting = false;

function spawnServer() {
  child = fork(serverEntry, process.argv.slice(2), {
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
    const exitDescriptor =
      signal ?? (typeof code === "number" ? `code ${code}` : "unknown");

    // Restart on: explicit restart request, or any non-zero exit (crash)
    if (restarting || (code !== 0 && code !== null)) {
      restarting = false;
      process.stderr.write(`[DevRunner] Server exited (${exitDescriptor}). Restarting...\n`);
      spawnServer();
      return;
    }

    process.stderr.write(`[DevRunner] Server exited (${exitDescriptor}). Shutting down.\n`);
    process.exit(0);
  });
}

function restartServer() {
  if (!child || restarting) {
    return;
  }

  restarting = true;
  process.stderr.write("[DevRunner] Restart requested. Stopping current server...\n");
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

process.stdout.write("[DevRunner] Starting server with tsx (explicit restarts only)\n");
spawnServer();
