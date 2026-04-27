import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { spawnProcess } from "./spawn.js";
import { isWindowsCommandScript } from "./windows-command.js";

export { quoteWindowsArgument, quoteWindowsCommand } from "./windows-command.js";

type Which = (command: string, options: { all: true }) => Promise<string[]>;

const require = createRequire(import.meta.url);
const which = require("which") as Which;
const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function enumerateCandidates(name: string): Promise<string[]> {
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

async function probeExecutable(executablePath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    let pendingResolve: ((result: boolean) => void) | null = resolve;
    let started = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: boolean) => {
      if (!pendingResolve) {
        return;
      }
      const fn = pendingResolve;
      pendingResolve = null;
      if (timer) {
        clearTimeout(timer);
      }
      fn(result);
    };

    let child: ChildProcess;
    try {
      child = spawnProcess(executablePath, ["--version"], {
        stdio: "ignore",
        // Windows batch shims (.cmd/.bat) require cmd.exe; native binaries do not.
        shell: isWindowsCommandScript(executablePath),
      });
    } catch {
      settle(false);
      return;
    }

    timer = setTimeout(() => {
      if (started) {
        child.kill();
        settle(true);
        return;
      }
      settle(false);
    }, PROBE_TIMEOUT_MS) as unknown as NodeJS.Timeout;
    timer.unref();

    child.once("spawn", () => {
      started = true;
    });
    child.once("error", () => {
      // ENOENT/EACCES/EPERM/UNKNOWN here means the OS could not start the candidate.
      settle(started);
    });
    child.once("exit", () => {
      settle(started);
    });
  });
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (exists(executablePath)) return executablePath;
  if (process.platform === "win32" && !extname(executablePath)) {
    for (const ext of [".exe", ".cmd"]) {
      const candidate = executablePath + ext;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export async function findExecutable(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed)) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed);
  const probeResults = await Promise.all(candidates.map((candidate) => probeExecutable(candidate)));
  const firstMatch = probeResults.findIndex((result) => result);
  return firstMatch === -1 ? null : candidates[firstMatch];
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
