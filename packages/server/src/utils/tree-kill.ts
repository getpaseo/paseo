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
  /** The process tree could not be read, so descendants outside the process group may survive. */
  onTreeReadFailed?: (error: unknown) => void;
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
  await signalProcessTree(child, options.gracefulSignal ?? "SIGTERM", options.onTreeReadFailed);
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  await signalProcessTree(child, options.forceSignal ?? "SIGKILL", options.onTreeReadFailed);
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
  onTreeReadFailed?: (error: unknown) => void,
): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          signalDirectChild(child, signal);
        }
        resolve();
      });
    });
  }
  return signalPosixTree(child, pid, signal, onTreeReadFailed);
}

// tree-kill spawns `ps` without an error listener, so a spawn failure (EAGAIN under a task
// limit) is an uncaught exception that takes the whole process down. This lists the tree
// through execFile, which reports the same failure to its callback.
async function signalPosixTree(
  child: TreeKillTarget,
  pid: number,
  signal: NodeJS.Signals,
  onTreeReadFailed?: (error: unknown) => void,
): Promise<void> {
  let pids: number[];
  try {
    pids = await listPosixTree(pid);
  } catch (error) {
    try {
      onTreeReadFailed?.(error);
    } catch {
      // A throwing observer must not stop the kill or reject close().
    }
    // Without the tree, the process group is the widest reach left: it covers every descendant
    // that did not start its own group, and exists only when the child leads one.
    try {
      process.kill(-pid, signal);
    } catch {
      // The child does not lead a group.
    }
    pids = [pid];
  }
  for (const target of pids) {
    try {
      process.kill(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH" && target === pid) {
        signalDirectChild(child, signal);
      }
    }
  }
}

function listPosixTree(rootPid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid="],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const childrenOf = new Map<number, number[]>();
        for (const line of stdout.split("\n")) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
          childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
        }
        const tree = [rootPid];
        for (const parent of tree) tree.push(...(childrenOf.get(parent) ?? []));
        resolve(tree);
      },
    );
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
