import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const daemonRunnerEntry = fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url));
const inspectArg = process.env.PASEO_NODE_INSPECT ?? "--inspect";
const inspectArgs =
  inspectArg === "0" || inspectArg === "false" || inspectArg === "off" ? [] : [inspectArg];

const supervisorArgs = [
  ...inspectArgs,
  "--heapsnapshot-near-heap-limit=3",
  "--max-old-space-size=3072",
  "--report-on-fatalerror",
  "--report-directory=/tmp/paseo-reports",
  ...process.execArgv,
  daemonRunnerEntry,
  "--dev",
  ...process.argv.slice(2),
];

const supervisor = spawn(process.execPath, supervisorArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    PASEO_LOG_FORMAT: process.env.PASEO_LOG_FORMAT ?? "pretty",
  },
});

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 1;
}

function forwardSignal(signal: NodeJS.Signals): void {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null || supervisor.killed) {
    return;
  }
  supervisor.kill(signal);
}

// The supervisor handles SIGINT/SIGTERM itself and needs time to drain the
// worker gracefully. Keep this wrapper alive until the supervisor exits so npm
// does not release the shell while the daemon is still logging final shutdown.
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

supervisor.on("error", (error) => {
  throw error;
});

supervisor.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? exitCodeForSignal(signal) : 1));
});
