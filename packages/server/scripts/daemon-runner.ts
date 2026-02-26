import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import { loadConfig } from "../src/server/config.js";
import { acquirePidLock, PidLockError, releasePidLock } from "../src/server/pid-lock.js";
import { resolveJunctionHome } from "../src/server/junction-home.js";
import { runSupervisor } from "./supervisor.js";


type DaemonRunnerConfig = {
  devMode: boolean;
  workerArgs: string[];
};

function parseConfig(argv: string[]): DaemonRunnerConfig {
  let devMode = false;
  const workerArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--dev") {
      devMode = true;
      continue;
    }
    workerArgs.push(arg);
  }

  return { devMode, workerArgs };
}

function resolveWorkerEntry(): string {
  const candidates = [
    fileURLToPath(new URL("../server/server/index.js", import.meta.url)),
    fileURLToPath(new URL("../dist/server/server/index.js", import.meta.url)),
    fileURLToPath(new URL("../src/server/index.ts", import.meta.url)),
    fileURLToPath(new URL("../../src/server/index.ts", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDevWorkerEntry(): string {
  const candidate = fileURLToPath(new URL("../src/server/index.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(`Dev worker entry not found: ${candidate}`);
  }
  return candidate;
}

function resolveWorkerExecArgv(workerEntry: string): string[] {
  return workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();
  const workerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JUNCTION_PID_LOCK_MODE: "external",
  };

  const junctionHome = resolveJunctionHome(workerEnv);
  const daemonConfig = loadConfig(junctionHome, { env: workerEnv });

  try {
    await acquirePidLock(junctionHome, daemonConfig.listen, {
      ownerPid: process.pid,
    });
  } catch (error) {
    if (error instanceof PidLockError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
      return;
    }
    throw error;
  }

  let lockReleased = false;
  const listenAddress = daemonConfig.listen;
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    await releasePidLock(junctionHome, listenAddress, {
      ownerPid: process.pid,
    });
  };

  runSupervisor({
    name: "DaemonRunner",
    startupMessage: config.devMode
      ? "Starting daemon worker (dev mode, crash restarts enabled)"
      : "Starting daemon worker (IPC restart enabled)",
    resolveWorkerEntry: () => workerEntry,
    workerArgs: config.workerArgs,
    workerEnv,
    workerExecArgv: resolveWorkerExecArgv(workerEntry),
    restartOnCrash: config.devMode,
    onSupervisorExit: releaseLock,
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
