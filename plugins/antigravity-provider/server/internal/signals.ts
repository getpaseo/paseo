import { execCommand } from "@getpaseo/plugin/server";

interface SignalOptions {
  platform: NodeJS.Platform;
  pid: number;
  signal: NodeJS.Signals;
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
  try {
    process.kill(plan.pid, plan.signal);
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return;
    if (hasErrorCode(error, "EPERM")) {
      try {
        process.kill(options.pid, plan.signal);
        return;
      } catch (fallbackError) {
        if (hasErrorCode(fallbackError, "ESRCH") || hasErrorCode(fallbackError, "EPERM")) return;
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function killTree(plan: Extract<SignalPlan, { type: "tree" }>): Promise<void> {
  try {
    await execCommand(plan.command, plan.args, { shell: false });
  } catch (error) {
    // taskkill reports an already-exited PID with exit code 128.
    if (!hasErrorCode(error, 128)) throw error;
  }
}

function hasErrorCode(error: unknown, expected: string | number): boolean {
  return error instanceof Error && "code" in error && error.code === expected;
}
