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
  beforeSignal?: (signal: NodeJS.Signals) => Promise<boolean>;
  signalProcessOnly?: boolean;
  onForceSignal?: () => void;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout"
  | "signal-skipped";

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
    if (options.beforeSignal && !(await options.beforeSignal(gracefulSignal))) {
      return "signal-skipped";
    }
    await signalTreeOrChild(
      child,
      gracefulSignal,
      options.signalProcessOnly ?? false,
      options.beforeSignal === undefined,
    );
    if (await waitForExitOrTimeout(exitObserver.promise, options.gracefulTimeoutMs)) {
      return "terminated";
    }

    const forceSignal = options.forceSignal ?? "SIGKILL";
    if (options.beforeSignal && !(await options.beforeSignal(forceSignal))) {
      return "signal-skipped";
    }
    options.onForceSignal?.();
    await signalTreeOrChild(
      child,
      forceSignal,
      options.signalProcessOnly ?? false,
      options.beforeSignal === undefined,
    );
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

function signalTreeOrChild(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
  signalProcessOnly: boolean,
  allowDirectFallback: boolean,
): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (signalProcessOnly || (typeof pid === "number" && pid < 0)) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error && allowDirectFallback) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  return signalTreeOrChild(child, signal, false, true);
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
