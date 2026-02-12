import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import { runSupervisor } from "./supervisor.js";

const WORKER_ENTRY = fileURLToPath(new URL("../src/server/index.ts", import.meta.url));
if (!existsSync(WORKER_ENTRY)) {
  throw new Error(`Dev worker entry not found: ${WORKER_ENTRY}`);
}

runSupervisor({
  name: "DevRunner",
  startupMessage: "Starting server worker (crash restarts enabled)",
  resolveWorkerEntry: () => WORKER_ENTRY,
  workerArgs: process.argv.slice(2),
  workerEnv: process.env,
  // Always run worker with tsx so dev server uses TypeScript sources directly.
  workerExecArgv: ["--import", "tsx"],
  restartOnCrash: true,
  shutdownReasons: ["cli_shutdown"],
});
