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

async function enumerateCandidates(name: string): Promise<string[]> {
  if (process.platform === "win32") {
    return enumerateCandidatesViaWindowsWhere(name);
  }
  if (existsSync("/usr/bin/which")) {
    return enumerateCandidatesViaSystemWhich(name);
  }
  return enumerateCandidatesViaLibrary(name);
}
async function enumerateCandidatesViaWindowsWhere(name: string): Promise<string[]> {
  try {
    const { stdout } = await execCommand("where.exe", [name], {
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(
      new Set(
        stdout
          .trim()
          .split("\r\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  } catch {
    return [];
  }
}

async function enumerateCandidatesViaSystemWhich(name: string): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch {
    return [];
  }
}

async function enumerateCandidatesViaLibrary(name: string): Promise<string[]> {
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

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

// A candidate is confirmed by running it, because a PATH hit is not proof it can
// launch: npm shims outlive their package and Microsoft Store app-execution
// aliases are stubs that exist but fail.
//
// Callers that only need "is it installed" — and would pay the full timeout for
// a binary that does not answer `--version`, as every Windows shell does — want
// findExecutableOnPath instead.
export async function probeExecutable(
  executablePath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await execCommand(executablePath, ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      shell: isWindowsCommandScript(executablePath),
    });
    return true;
  } catch (error) {
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

async function findWith(
  name: string,
  probe: (executablePath: string, timeoutMs: number) => Promise<boolean>,
  probeTimeoutMs: number,
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: enumerateCandidates,
      probeExecutable: probe,
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probe(trimmed, probeTimeoutMs)) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed);
  for (const candidate of candidates) {
    if (await probe(candidate, probeTimeoutMs)) {
      return candidate;
    }
  }
  return null;
}

export async function findExecutable(
  name: string,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  return findWith(name, probeExecutable, probeTimeoutMs);
}

/**
 * Locate a binary the same way as findExecutable, but confirm it by existence
 * rather than by running it.
 *
 * For an interactive shell, launching is the test the user is about to perform
 * anyway, and a bad entry surfaces as a spawn error. Probing buys little and
 * costs the full timeout per shell that has no `--version` to answer.
 */
export async function findExecutableOnPath(name: string): Promise<string | null> {
  return findWith(name, async (executablePath) => existsSync(executablePath), PROBE_TIMEOUT_MS);
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
