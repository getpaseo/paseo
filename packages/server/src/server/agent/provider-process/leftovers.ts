import { readdir, readFile } from "node:fs/promises";
import { execCommand } from "../../../utils/spawn.js";

const PS_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 2_000;
const RESCAN_INTERVAL_MS = 200;

/**
 * Processes whose environment carries `NAME=value`. Claude Code and Antigravity start each shell
 * command in a new session, so once the provider is gone neither its process tree nor its
 * process group reaches them; the inherited variable does.
 */
export interface ProcessMarker {
  platform: NodeJS.Platform;
  name: string;
  value: string;
}

export async function findMarkedProcesses(input: ProcessMarker): Promise<number[]> {
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

// macOS has no /proc. `ps -E` prints the command line followed by the environment, both
// space-separated, for the caller's own processes. The same listing without `-E` gives the
// command line alone, so only what follows it is matched: a marker passed as an argument does
// not count.
async function findMarkedPsProcesses(entry: string): Promise<number[]> {
  const commandLines = await runPs(["-A", "-ww", "-o", "pid=,command="]);
  const withEnvironment = await runPs(["-A", "-ww", "-E", "-o", "pid=,command="]);
  return markedPidsFromPs({ commandLines, withEnvironment, entry }).filter(
    (pid) => pid !== process.pid,
  );
}

/** PIDs whose environment, the part of the `ps -E` line after the command line, holds `entry`. */
export interface PsListings {
  /** `ps -A -ww -o pid=,command=` */
  commandLines: string;
  /** The same with `-E`. */
  withEnvironment: string;
  entry: string;
}

export function markedPidsFromPs(input: PsListings): number[] {
  const commandLines = parsePsLines(input.commandLines);
  const found: number[] = [];
  for (const [pid, line] of parsePsLines(input.withEnvironment)) {
    const commandLine = commandLines.get(pid);
    if (commandLine === undefined || !line.startsWith(commandLine)) continue;
    if (line.slice(commandLine.length).split(/\s+/).includes(input.entry)) found.push(pid);
  }
  return found;
}

async function runPs(args: string[]): Promise<string> {
  const { stdout } = await execCommand("ps", args, {
    envMode: "internal",
    envOverlay: { LC_ALL: "C" },
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function parsePsLines(stdout: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (match) lines.set(Number(match[1]), match[2]);
  }
  return lines;
}

/**
 * SIGTERM every marked process, then SIGKILL whatever still carries the marker after a short
 * grace period. Each pass looks the processes up again by marker, so a PID that exited and was
 * reused in between is not signalled. Returns every PID that was signalled.
 */
export async function stopMarkedPosixProcesses(input: ProcessMarker): Promise<number[]> {
  const stopped = new Set(await findMarkedProcesses(input));
  signalAll([...stopped], "SIGTERM");
  const deadline = Date.now() + TERMINATE_GRACE_MS;
  let remaining = [...stopped];
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESCAN_INTERVAL_MS));
    remaining = await findMarkedProcesses(input);
  }
  signalAll(remaining, "SIGKILL");
  for (const pid of remaining) stopped.add(pid);
  return [...stopped];
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

function isErrnoCode(error: unknown, codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}
