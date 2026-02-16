import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import { runSupervisor } from "./supervisor.js";
import { applySherpaLoaderEnv } from "../src/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

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

const config = parseConfig(process.argv.slice(2));
const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();

applySherpaLoaderEnv(process.env);

runSupervisor({
  name: "DaemonRunner",
  startupMessage: config.devMode
    ? "Starting daemon worker (dev mode, crash restarts enabled)"
    : "Starting daemon worker (IPC restart enabled)",
  resolveWorkerEntry: () => workerEntry,
  workerArgs: config.workerArgs,
  workerEnv: process.env,
  workerExecArgv: resolveWorkerExecArgv(workerEntry),
  restartOnCrash: config.devMode,
  shutdownReasons: ["cli_shutdown"],
});
