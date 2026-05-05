import { execFile } from "node:child_process";

export interface ProcessTreeTarget {
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

interface SignalProcessTreeOptions {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  execFile?: (
    file: string,
    args: string[],
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => unknown;
}

interface TerminateProcessTreeOptions extends SignalProcessTreeOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
}

export type TerminateProcessTreeResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

export async function terminateProcessTree(
  child: ProcessTreeTarget,
  options: TerminateProcessTreeOptions,
): Promise<TerminateProcessTreeResult> {
  if (isProcessExited(child)) {
    return "already-exited";
  }

  const exitPromise = waitForProcessExit(child);
  signalProcessTree(child, options.gracefulSignal ?? "SIGTERM", options);
  if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
    return "terminated";
  }

  options.onForceSignal?.();
  signalProcessTree(child, options.forceSignal ?? "SIGKILL", options);
  if (options.forceTimeoutMs === undefined) {
    return "killed";
  }
  return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
    ? "killed"
    : "kill-timeout";
}

export function signalProcessTree(
  child: ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: SignalProcessTreeOptions = {},
): void {
  if (isProcessExited(child)) {
    return;
  }

  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
      signalWindowsProcessTree(child, pid, signal, options);
      return;
    }

    try {
      (options.kill ?? process.kill.bind(process))(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when no separate process group exists.
    }
  }

  signalDirectChild(child, signal);
}

function signalWindowsProcessTree(
  child: ProcessTreeTarget,
  pid: number,
  signal: NodeJS.Signals,
  options: SignalProcessTreeOptions,
): void {
  const args = ["/pid", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }

  try {
    (options.execFile ?? execFile)("taskkill", args, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
    });
  } catch {
    signalDirectChild(child, signal);
  }
}

function signalDirectChild(child: ProcessTreeTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: ProcessTreeTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: ProcessTreeTarget): Promise<void> {
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
