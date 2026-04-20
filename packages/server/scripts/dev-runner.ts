import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const daemonRunnerEntry = fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url));

// The supervisor handles SIGINT/SIGTERM itself and needs time to drain the
// worker gracefully. Ignore them here so spawnSync blocks until the supervisor
// finishes shutting down, instead of the parent dying on Ctrl-C and releasing
// the shell while the daemon is still logging.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const result = spawnSync(
  process.execPath,
  [
    "--inspect",
    "--heapsnapshot-near-heap-limit=3",
    "--max-old-space-size=3072",
    "--report-on-fatalerror",
    "--report-directory=/tmp/paseo-reports",
    ...process.execArgv,
    daemonRunnerEntry,
    "--dev",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
