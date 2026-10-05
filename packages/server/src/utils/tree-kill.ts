import { execFile } from "node:child_process";
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

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return killProcessTree(pid, signal).catch(() => {
    // Discovery can fail while a provider is being retired. Keep that failure
    // within this operation; the ChildProcess handle still owns the root.
    signalDirectChild(child, signal);
  });
}

async function killProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return;
  }

  // tree-kill recursively spawns pgrep/ps from close callbacks without handling
  // spawn throws or child errors. An EBADF there escapes the caller's Promise
  // and crashes the daemon. One bounded snapshot avoids that recursive spawn
  // path and handles both synchronous and asynchronous discovery failures.
  const snapshot = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid="],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
  const children = new Map<number, number[]>();
  for (const line of snapshot.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const descendant = Number(match[1]);
    const parent = Number(match[2]);
    if (!Number.isSafeInteger(descendant) || descendant <= 0) continue;
    const entries = children.get(parent) ?? [];
    entries.push(descendant);
    children.set(parent, entries);
  }
  const seen = new Set<number>([pid]);
  const ordered = [pid];
  for (let index = 0; index < ordered.length; index++) {
    for (const descendant of children.get(ordered[index]!) ?? []) {
      if (seen.has(descendant)) continue;
      seen.add(descendant);
      ordered.push(descendant);
    }
  }
  // Descendants first, including those with their own process groups.
  for (let index = ordered.length - 1; index >= 0; index--) {
    const target = ordered[index]!;
    try {
      process.kill(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
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
