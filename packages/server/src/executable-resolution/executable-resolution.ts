import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execCommand } from "../utils/spawn.js";
import { isWindowsCommandScript } from "../utils/windows-command.js";
import { windowsExecutableResolution } from "./windows.js";

export { quoteWindowsArgument, quoteWindowsCommand } from "../utils/windows-command.js";

type Which = (command: string, options: { all: true }) => Promise<string[]>;

const require = createRequire(import.meta.url);
const which = require("which") as Which;
const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (process.platform !== "win32" && existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name, signal);
  }
  return enumerateCandidatesViaLibrary(name, signal);
}

async function enumerateCandidatesViaSystemWhich(
  name: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      timeout: 3000,
      killSignal: "SIGKILL",
      signal,
    });
    signal?.throwIfAborted();
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return [];
  }
}

async function enumerateCandidatesViaLibrary(
  name: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  signal?.throwIfAborted();

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    await execCommand(executablePath, ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: isWindowsCommandScript(executablePath),
      signal,
    });
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

export async function findExecutable(
  name: string,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (candidate) => enumerateCandidates(candidate, signal),
      probeExecutable: (candidate, timeoutMs) => probeExecutable(candidate, timeoutMs, signal),
      exists: existsSync,
      probeTimeoutMs,
      signal,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, probeTimeoutMs, signal)) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed, signal);
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (await probeExecutable(candidate, probeTimeoutMs, signal)) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string, signal?: AbortSignal): Promise<boolean> {
  return (await findExecutable(command, PROBE_TIMEOUT_MS, signal)) !== null;
}
