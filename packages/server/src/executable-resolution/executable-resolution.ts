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

export interface ExecutableResolutionOptions {
  probeTimeoutMs?: number;
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Executable resolution aborted");
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
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
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch {
    throwIfAborted(signal);
    return [];
  }
}

async function enumerateCandidatesViaLibrary(
  name: string,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);
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
  throwIfAborted(signal);

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
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const timeoutMs =
    typeof options === "number" ? options : (options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = typeof options === "number" ? undefined : options.signal;
  throwIfAborted(signal);
  try {
    await execCommand(executablePath, ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: isWindowsCommandScript(executablePath),
      signal,
    });
    throwIfAborted(signal);
    return true;
  } catch (error) {
    throwIfAborted(signal);
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
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const probeTimeoutMs =
    typeof options === "number" ? options : (options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = typeof options === "number" ? undefined : options.signal;
  throwIfAborted(signal);
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (candidate) => enumerateCandidates(candidate, signal),
      probeExecutable,
      exists: existsSync,
      probeTimeoutMs,
      signal,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, { probeTimeoutMs, signal })) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed, signal);
  for (const candidate of candidates) {
    throwIfAborted(signal);
    if (await probeExecutable(candidate, { probeTimeoutMs, signal })) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(
  command: string,
  options: ExecutableResolutionOptions = {},
): Promise<boolean> {
  return (await findExecutable(command, options)) !== null;
}
