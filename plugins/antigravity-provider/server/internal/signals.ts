import { execCommand } from "@getpaseo/plugin/server";

interface SignalOptions {
  platform: NodeJS.Platform;
  pid: number;
  signal: NodeJS.Signals;
  /** Delivers a POSIX signal. Defaults to `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

type SignalPlan =
  | { type: "group"; pid: number; signal: NodeJS.Signals }
  | { type: "tree"; command: "taskkill"; args: string[] };

export function signalPlan(options: SignalOptions): SignalPlan {
  if (options.platform === "win32") {
    return { type: "tree", command: "taskkill", args: ["/PID", String(options.pid), "/T", "/F"] };
  }
  return { type: "group", pid: -options.pid, signal: options.signal };
}

export function signalProcess(options: SignalOptions): void | Promise<void> {
  const plan = signalPlan(options);
  if (plan.type === "tree") return killTree(plan);
  const kill = options.kill ?? deliverSignal;
  try {
    kill(plan.pid, plan.signal);
  } catch (error) {
    if (!isSettledGroup(error)) throw error;
  }
}

function deliverSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

// ESRCH means the group is gone. macOS answers EPERM when any member of the group could not be
// signaled, which includes members that have exited but are not reaped yet; the members it could
// reach still got the signal. These signals are sent from timers, so a throw here crashes the daemon.
function isSettledGroup(error: unknown): boolean {
  if (!(error instanceof Error && "code" in error)) return false;
  return error.code === "ESRCH" || error.code === "EPERM";
}

async function killTree(plan: Extract<SignalPlan, { type: "tree" }>): Promise<void> {
  try {
    await execCommand(plan.command, plan.args, { shell: false });
  } catch (error) {
    // taskkill reports an already-exited PID with exit code 128.
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}
