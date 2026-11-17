import { readdir, readFile } from "node:fs/promises";
import { execCommand } from "../../../utils/spawn.js";

const PS_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 2_000;
const EXIT_POLL_MS = 50;

/**
 * Processes whose environment carries `NAME=value`. Claude Code and Antigravity start each shell
 * command in a new session, so once the provider is gone neither its process tree nor its
 * process group reaches them; the inherited variable does.
 */
export async function findMarkedProcesses(input: {
  platform: NodeJS.Platform;
  name: string;
  value: string;
}): Promise<number[]> {
  const entry = `${input.name}=${input.value}`;
  if (input.platform === "linux") return findMarkedLinuxProcesses(entry);
  return findMarkedPsProcesses(entry);
}

async function findMarkedLinuxProcesses(entry: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environment: string;
    try {
      environment = await readFile(`/proc/${pid}/environ`, "utf8");
    } catch (error) {
      // Gone since readdir, or another user's process.
      if (isErrnoCode(error, ["ENOENT", "ESRCH", "EACCES", "EPERM"])) continue;
      throw error;
    }
    if (environment.split("\0").includes(entry)) found.push(pid);
  }
  return found;
}

// macOS has no /proc. `ps -E` appends the environment to the command line, space-separated,
// for the caller's own processes.
async function findMarkedPsProcesses(entry: string): Promise<number[]> {
  const { stdout } = await execCommand("ps", ["-A", "-ww", "-E", "-o", "pid=,command="], {
    envMode: "internal",
    envOverlay: { LC_ALL: "C" },
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const found: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid && match[2].split(/\s+/).includes(entry)) found.push(pid);
  }
  return found;
}

/** SIGTERM, then SIGKILL whatever is still running after a short grace period. */
export async function terminatePosixProcesses(pids: number[]): Promise<void> {
  signalAll(pids, "SIGTERM");
  const deadline = Date.now() + TERMINATE_GRACE_MS;
  let running = pids.filter(isRunning);
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    running = running.filter(isRunning);
  }
  signalAll(running, "SIGKILL");
}

export async function terminateWindowsProcesses(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      await execCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        envMode: "internal",
        shell: false,
        timeout: PS_TIMEOUT_MS,
      });
    } catch (error) {
      // 128: the process exited before taskkill reached it (an earlier /T may have taken it).
      if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
    }
  }
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!isErrnoCode(error, ["ESRCH"])) throw error;
    }
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, ["ESRCH"])) return false;
    throw error;
  }
}

function isErrnoCode(error: unknown, codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}
