import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const daemonRunnerEntry = fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url));

// Default heap is 3GB; large repos with the in-process Hubcode Local
// embedding model (Xenova/BGE) easily push past that and get OOM-killed.
// Override via HUBCODE_NODE_HEAP_MB (default raised to 6GB).
const heapMb = (() => {
  const env = Number.parseInt(process.env.HUBCODE_NODE_HEAP_MB ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 6144;
})();

const result = spawnSync(
  process.execPath,
  [
    "--inspect",
    "--heapsnapshot-near-heap-limit=3",
    `--max-old-space-size=${heapMb}`,
    // Lets `hubcode-local-inference` trigger periodic synchronous GC to keep
    // RSS flat across thousands of embedding batches (extractor caches grow
    // monotonically without it).
    "--expose-gc",
    "--report-on-fatalerror",
    "--report-directory=/tmp/hubcode-reports",
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
