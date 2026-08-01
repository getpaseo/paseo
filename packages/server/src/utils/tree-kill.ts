import treeKill from "tree-kill";

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
  off?(event: "exit", listener: () => void): unknown;
  observeExit?(listener: () => void): () => void;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
  beforeSignal?: (signal: NodeJS.Signals) => boolean | Promise<boolean>;
  treeKiller?: TreeKiller;
  preserveRootOnTreeFailure?: boolean;
}

export type TreeKiller = (
  pid: number,
  signal: NodeJS.Signals,
  callback: (error?: Error) => void,
) => void;

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "signal-skipped"
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

  const exitObserver = observeProcessExit(child);
  try {
    const gracefulSignal = options.gracefulSignal ?? "SIGTERM";
    if (!(await shouldSignal(options, gracefulSignal))) {
      return "signal-skipped";
    }
    if (
      !(await signalTreeOrChild(
        child,
        gracefulSignal,
        options.treeKiller ?? treeKill,
        options.preserveRootOnTreeFailure ?? false,
      ))
    ) {
      return "kill-timeout";
    }
    if (await waitForExitOrTimeout(exitObserver.promise, options.gracefulTimeoutMs)) {
      return "terminated";
    }

    const forceSignal = options.forceSignal ?? "SIGKILL";
    if (!(await shouldSignal(options, forceSignal))) {
      return "signal-skipped";
    }
    options.onForceSignal?.();
    if (
      !(await signalTreeOrChild(
        child,
        forceSignal,
        options.treeKiller ?? treeKill,
        options.preserveRootOnTreeFailure ?? false,
      ))
    ) {
      return "kill-timeout";
    }
    if (options.forceTimeoutMs === undefined) {
      return "killed";
    }
    return (await waitForExitOrTimeout(exitObserver.promise, options.forceTimeoutMs))
      ? "killed"
      : "kill-timeout";
  } finally {
    exitObserver.cancel();
  }
}

async function shouldSignal(
  options: TerminateWithTreeKillOptions,
  signal: NodeJS.Signals,
): Promise<boolean> {
  return options.beforeSignal ? await options.beforeSignal(signal) : true;
}

function signalTreeOrChild(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
  treeKiller: TreeKiller,
  preserveRootOnTreeFailure: boolean,
): Promise<boolean> {
  if (isProcessExited(child)) {
    return Promise.resolve(true);
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    treeKiller(pid, signal, (error) => {
      if (!error) {
        resolve(true);
        return;
      }
      if (preserveRootOnTreeFailure) {
        // Retrying callers preserve the root so its descendants stay discoverable.
        resolve(false);
        return;
      }
      signalDirectChild(child, signal);
      resolve(true);
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

function observeProcessExit(child: TreeKillTarget): {
  promise: Promise<void>;
  cancel: () => void;
} {
  if (isProcessExited(child)) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  if (child.observeExit) {
    let resolveExit: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    return { promise, cancel: child.observeExit(resolveExit) };
  }
  if (!child.once) {
    return { promise: new Promise(() => undefined), cancel: () => undefined };
  }

  let listener: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    listener = resolve;
    child.once?.("exit", listener);
  });
  return {
    promise,
    cancel: () => child.off?.("exit", listener),
  };
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
