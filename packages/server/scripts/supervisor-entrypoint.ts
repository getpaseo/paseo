import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  acquirePidLock,
  PidLockError,
  releasePidLock,
  updatePidLock,
} from "../src/server/pid-lock.js";
import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { loadPersistedConfig } from "../src/server/persisted-config.js";
import { runSupervisor } from "./supervisor.js";
import { applySherpaLoaderEnv } from "../src/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

const DEFAULT_DAEMON_LOG_FILENAME = "daemon.log";
const DEFAULT_LOG_ROTATE_SIZE = "10m";
const DEFAULT_LOG_ROTATE_MAX_FILES = 2;

interface DaemonRunnerConfig {
  devMode: boolean;
  workerArgs: string[];
}

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
    fileURLToPath(new URL("../server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url)),
    fileURLToPath(new URL("../../src/server/daemon-worker.ts", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDevWorkerEntry(): string {
  const candidate = fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(`Dev worker entry not found: ${candidate}`);
  }
  return candidate;
}

function resolveWorkerExecArgv(workerEntry: string): string[] {
  return workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function resolvePackagedNodeEntrypointRunnerPath(currentScriptPath: string): string | null {
  const packageMarker = `${path.sep}node_modules${path.sep}@getpaseo${path.sep}server${path.sep}`;
  const markerIndex = currentScriptPath.lastIndexOf(packageMarker);
  if (markerIndex === -1) {
    return null;
  }

  const appRoot = currentScriptPath.slice(0, markerIndex);
  const runnerPath = path.join(appRoot, "dist", "daemon", "node-entrypoint-runner.js");
  return existsSync(runnerPath) ? runnerPath : null;
}

function resolveSupervisorLogFile(
  paseoHome: string,
  persistedConfig: ReturnType<typeof loadPersistedConfig>,
) {
  const configuredFile = persistedConfig.log?.file;
  const configuredPath = configuredFile?.path;
  let logPath = path.join(paseoHome, DEFAULT_DAEMON_LOG_FILENAME);
  if (configuredPath) {
    logPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(paseoHome, configuredPath);
  }

  return {
    path: logPath,
    rotate: {
      maxSize: configuredFile?.rotate?.maxSize ?? DEFAULT_LOG_ROTATE_SIZE,
      maxFiles: configuredFile?.rotate?.maxFiles ?? DEFAULT_LOG_ROTATE_MAX_FILES,
    },
  };
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();
  const workerExecArgv = resolveWorkerExecArgv(workerEntry);
  const workerEnv: NodeJS.ProcessEnv = { ...process.env };
  const packagedNodeEntrypointRunner =
    process.env.ELECTRON_RUN_AS_NODE === "1"
      ? resolvePackagedNodeEntrypointRunnerPath(fileURLToPath(import.meta.url))
      : null;

  applySherpaLoaderEnv(workerEnv);

  const paseoHome = resolvePaseoHome(workerEnv);
  const persistedConfig = loadPersistedConfig(paseoHome);
  const supervisorLogFile = resolveSupervisorLogFile(paseoHome, persistedConfig);

  try {
    await acquirePidLock(paseoHome, null, {
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
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    await releasePidLock(paseoHome, {
      ownerPid: process.pid,
    });
  };

  runSupervisor({
    name: "DaemonRunner",
    startupMessage: "Starting daemon worker (IPC restart and crash restart enabled)",
    resolveWorkerEntry: () => workerEntry,
    workerArgs: config.workerArgs,
    workerEnv,
    workerExecArgv,
    resolveWorkerSpawnSpec: packagedNodeEntrypointRunner
      ? (resolvedWorkerEntry) => ({
          command: process.execPath,
          args: [
            packagedNodeEntrypointRunner,
            "node-script",
            resolvedWorkerEntry,
            ...config.workerArgs,
          ],
          env: {
            ...workerEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
        })
      : undefined,
    restartOnCrash: true,
    logFile: supervisorLogFile,
    onWorkerReady: async ({ listen }) => {
      await updatePidLock(paseoHome, { listen }, { ownerPid: process.pid });
    },
    onSupervisorExit: releaseLock,
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
