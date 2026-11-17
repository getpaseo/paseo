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

export function signalProcess(
  options: SignalOptions,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void | Promise<void> {
  const plan = signalPlan(options);
  if (plan.type === "tree") return killTree(plan);
  try {
    kill(plan.pid, plan.signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return;
    // On macOS/XNU, kill(-pgid, sig) fails with EPERM when the group leader has exited into a
    // zombie state before waitpid reaps it, or when a descendant executed a setuid binary.
    if (code === "EPERM") {
      try {
        kill(options.pid, options.signal);
      } catch (fallbackError) {
        const fallbackCode =
          fallbackError instanceof Error && "code" in fallbackError
            ? fallbackError.code
            : undefined;
        if (fallbackCode === "ESRCH" || fallbackCode === "EPERM") return;
        throw fallbackError;
      }
      return;
    }
    throw error;
  }
}

async function killTree(plan: Extract<SignalPlan, { type: "tree" }>): Promise<void> {
  try {
    await execCommand(plan.command, plan.args, { shell: false });
  } catch (error) {
    // taskkill reports an already-exited PID with exit code 128.
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}
