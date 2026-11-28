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
  /** Only set for a process spawned as the leader of its own POSIX process group. */
  ownsProcessGroup?: boolean;
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
  const processGroupId =
    options.ownsProcessGroup && child.pid !== undefined && child.pid > 1 ? child.pid : undefined;
  const launcherExited = isProcessExited(child);
  if (launcherExited && (processGroupId === undefined || !signalGroup(processGroupId, 0))) {
    return "already-exited";
  }

  const waitForExit = createExitWaiter(child, processGroupId);

  const gracefulSignal = options.gracefulSignal ?? "SIGTERM";
  if (launcherExited && processGroupId !== undefined) {
    signalGroup(processGroupId, gracefulSignal);
  } else {
    await signalProcessTree(child, gracefulSignal);
  }
  if (await waitForExit(options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  const forceSignal = options.forceSignal ?? "SIGKILL";
  await signalProcessTree(child, forceSignal);
  if (processGroupId !== undefined) {
    // The tree walk loses sight of children once their launcher exits.
    signalGroup(processGroupId, forceSignal);
  }
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExit(options.forceTimeoutMs)) ? "killed" : "kill-timeout";
}

function createExitWaiter(
  child: TreeKillTarget,
  processGroupId: number | undefined,
): (timeoutMs: number) => Promise<boolean> {
  if (processGroupId !== undefined) {
    return (timeoutMs) => waitForProcessGroupExit(processGroupId, timeoutMs);
  }
  const exitPromise = waitForProcessExit(child);
  return (timeoutMs) => waitForExitOrTimeout(exitPromise, timeoutMs);
}

function signalGroup(groupId: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (signalGroup(groupId, 0)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
  }
  return true;
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
