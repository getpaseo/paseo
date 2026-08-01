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
  signal?: AbortSignal;
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
  options.signal?.throwIfAborted();
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitObserver = observeProcessExit(child);
  try {
    const gracefulSignal = options.gracefulSignal ?? "SIGTERM";
    options.signal?.throwIfAborted();
    if (!(await shouldSignal(options, gracefulSignal))) {
      return "signal-skipped";
    }
    if (
      !(await signalTreeOrChild(
        child,
        gracefulSignal,
        options.treeKiller ?? treeKill,
        options.preserveRootOnTreeFailure ?? false,
        options.signal,
      ))
    ) {
      return "kill-timeout";
    }
    if (
      await waitForExitOrTimeout(exitObserver.promise, options.gracefulTimeoutMs, options.signal)
    ) {
      return "terminated";
    }

    const forceSignal = options.forceSignal ?? "SIGKILL";
    options.signal?.throwIfAborted();
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
        options.signal,
      ))
    ) {
      return "kill-timeout";
    }
    if (options.forceTimeoutMs === undefined) {
      return "killed";
    }
    return (await waitForExitOrTimeout(
      exitObserver.promise,
      options.forceTimeoutMs,
      options.signal,
    ))
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
  options.signal?.throwIfAborted();
  return options.beforeSignal ? await options.beforeSignal(signal) : true;
}

function signalTreeOrChild(
  child: TreeKillTarget,
  killSignal: NodeJS.Signals,
  treeKiller: TreeKiller,
  preserveRootOnTreeFailure: boolean,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  abortSignal?.throwIfAborted();
  if (isProcessExited(child)) {
    return Promise.resolve(true);
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, killSignal);
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = abortSignal?.aborted ?? false;
    const onAbort = () => {
      // tree-kill cannot be cancelled. Its callback retains signal ownership.
      aborted = true;
    };
    const settle = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal?.removeEventListener("abort", onAbort);
      complete();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      treeKiller(pid, killSignal, (error) => {
        settle(() => {
          if (aborted) {
            reject(abortSignal?.reason);
            return;
          }
          if (!error) {
            resolve(true);
            return;
          }
          if (preserveRootOnTreeFailure) {
            // Retrying callers preserve the root so its descendants stay discoverable.
            resolve(false);
            return;
          }
          signalDirectChild(child, killSignal);
          resolve(true);
        });
      });
    } catch (error) {
      settle(() => reject(aborted ? abortSignal?.reason : error));
    }
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
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
      new Promise<boolean>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
