import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import treeKill from "tree-kill";

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export async function terminateWithTreeKill(
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitPromise = waitForProcessExit(child);
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM");
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL");
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

interface PosixProcess {
  pid: number;
  parentPid: number;
  state: string;
  startedAt: string;
}

const execFileAsync = promisify(execFile);

async function readPosixProcessTable(timeoutMs: number): Promise<PosixProcess[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "stat=", "-o", "lstart="],
    {
      env: { ...process.env, LC_ALL: "C" },
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
      if (!match) throw new Error("Cannot read process identity from ps");
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        state: match[3],
        startedAt: match[4],
      };
    });
}

/** Retains ownership across retries, when a tool may have already been reparented. */
export class CapturedProcessDescendants {
  private readonly startedByPid = new Map<number, string>();

  async capture(child: TreeKillTarget): Promise<void> {
    if (process.platform === "win32" || !child.pid || isProcessExited(child)) return;
    const snapshot = await readPosixProcessTable(750);
    if (!isProcessExited(child)) this.rememberDescendants(snapshot, [child.pid]);
  }

  async confirmExit(timeoutMs: number): Promise<void> {
    if (this.startedByPid.size === 0) return;
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new Error("Tool processes did not exit after SIGKILL");

      const snapshot = await readPosixProcessTable(remaining);
      const survivors = snapshot.filter((entry) => this.isOwnedAndRunning(entry));
      if (survivors.length === 0) {
        this.startedByPid.clear();
        return;
      }
      // A surviving tool can have forked during graceful shutdown.
      this.rememberDescendants(
        snapshot,
        survivors.map(({ pid }) => pid),
      );
      for (const entry of snapshot) {
        if (!this.isOwnedAndRunning(entry)) continue;
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await sleep(25);
    }
  }

  private isOwnedAndRunning(entry: PosixProcess): boolean {
    // A zombie has exited. The birth time distinguishes a captured tool from a reused PID.
    return !entry.state.startsWith("Z") && this.startedByPid.get(entry.pid) === entry.startedAt;
  }

  private rememberDescendants(snapshot: PosixProcess[], roots: number[]): void {
    const children = new Map<number, PosixProcess[]>();
    for (const entry of snapshot) {
      const siblings = children.get(entry.parentPid);
      if (siblings) siblings.push(entry);
      else children.set(entry.parentPid, [entry]);
    }
    const visited = new Set(roots);
    const queue = [...roots];
    for (const parentPid of queue) {
      for (const child of children.get(parentPid) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        queue.push(child.pid);
        this.startedByPid.set(child.pid, child.startedAt);
      }
    }
  }
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
