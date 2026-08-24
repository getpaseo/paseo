import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 20_000;

function runNpm(args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to start npm: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runWithRetry(
  args,
  { attempts = DEFAULT_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS, run = runNpm, sleep = wait } = {},
) {
  let exitCode = 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    exitCode = await run(args);
    if (exitCode === 0) {
      return 0;
    }

    if (attempt < attempts) {
      const delayMs = attempt * backoffMs;
      console.warn(
        `npm failed with exit code ${exitCode}; retrying in ${delayMs / 1000}s (${attempt + 1}/${attempts})`,
      );
      await sleep(delayMs);
    }
  }

  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/npm-retry.mjs <npm arguments...>");
    process.exitCode = 2;
  } else {
    process.exitCode = await runWithRetry(args);
  }
}
