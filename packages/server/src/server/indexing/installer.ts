import { spawn as nodeSpawn } from "node:child_process";
import type { Logger } from "pino";

/**
 * Installer for `code-review-graph`.
 *
 * Strategy chain (first viable wins):
 *   1. `pipx` available → `pipx install code-review-graph`
 *   2. macOS + `brew` available → `brew install pipx && pipx install code-review-graph`
 *   3. otherwise → unsupported (UI keeps the copy-command fallback)
 *
 * Auto-sudo on Linux and Python bootstrap on Windows are intentionally
 * out of scope: the cost of getting them wrong silently (broken environments,
 * orphaned processes) outweighs the convenience. Those platforms fall
 * through to manual install with a one-click "Re-check" in the UI.
 */

export type InstallStrategy =
  | { kind: "pipx"; command: "pipx"; args: string[] }
  | { kind: "brew-then-pipx"; steps: Array<{ command: string; args: string[] }> }
  | { kind: "python3-bootstrap-pipx"; steps: Array<{ command: string; args: string[] }> }
  | { kind: "unsupported"; reason: string };

export interface InstallerDeps {
  logger: Logger;
  pipxAvailable: boolean;
  brewAvailable: boolean;
  python3Available: boolean;
  platform: NodeJS.Platform;
  /** Inject for tests. Default: node:child_process spawn + streaming. */
  runCommand?: (command: string, args: string[]) => AsyncIterable<CommandOutput>;
}

export interface CommandOutput {
  kind: "stdout" | "stderr" | "exit";
  text?: string;
  exitCode?: number | null;
}

export type InstallEvent =
  | { type: "plan"; strategy: InstallStrategy }
  | { type: "step-started"; command: string; args: string[]; index: number; total: number }
  | { type: "step-output"; stream: "stdout" | "stderr"; text: string }
  | { type: "step-completed"; command: string; exitCode: number | null }
  | { type: "completed"; success: boolean; error?: string };

export function planInstallStrategy(deps: {
  pipxAvailable: boolean;
  brewAvailable: boolean;
  python3Available: boolean;
  platform: NodeJS.Platform;
}): InstallStrategy {
  if (deps.pipxAvailable) {
    return { kind: "pipx", command: "pipx", args: ["install", "code-review-graph"] };
  }
  if (deps.platform === "darwin" && deps.brewAvailable) {
    return {
      kind: "brew-then-pipx",
      steps: [
        { command: "brew", args: ["install", "pipx"] },
        { command: "pipx", args: ["ensurepath"] },
        { command: "pipx", args: ["install", "code-review-graph"] },
      ],
    };
  }
  // Bootstrap pipx via Python's user-site pip when python3 ≥ 3.10 is on
  // PATH. Most distros (incl. macOS without brew) ship Python; this avoids
  // needing root. `--break-system-packages` opts in past PEP 668 — required
  // on Python 3.13's Apple-managed install and on Debian/Ubuntu, but safe
  // here because we scope to user-site (`--user`) and the user explicitly
  // clicked Install.
  if (deps.python3Available) {
    return {
      kind: "python3-bootstrap-pipx",
      steps: [
        {
          command: "python3",
          args: ["-m", "pip", "install", "--user", "--break-system-packages", "pipx"],
        },
        { command: "python3", args: ["-m", "pipx", "ensurepath"] },
        { command: "python3", args: ["-m", "pipx", "install", "code-review-graph"] },
      ],
    };
  }
  return {
    kind: "unsupported",
    reason:
      deps.platform === "linux"
        ? "Auto-install requires Python 3.10+ or pipx. Install one, then re-check."
        : deps.platform === "win32"
          ? "Auto-install requires Python 3.10+ (via winget) or pipx. Install one, then re-check."
          : "Install Python 3.10+ or pipx, then re-check.",
  };
}

export async function* runCrgInstall(
  deps: InstallerDeps,
): AsyncGenerator<InstallEvent, void, void> {
  const { logger } = deps;
  const strategy = planInstallStrategy({
    pipxAvailable: deps.pipxAvailable,
    brewAvailable: deps.brewAvailable,
    python3Available: deps.python3Available,
    platform: deps.platform,
  });
  yield { type: "plan", strategy };
  if (strategy.kind === "unsupported") {
    yield { type: "completed", success: false, error: strategy.reason };
    return;
  }
  const steps =
    strategy.kind === "pipx"
      ? [{ command: strategy.command, args: strategy.args }]
      : strategy.kind === "brew-then-pipx" || strategy.kind === "python3-bootstrap-pipx"
        ? strategy.steps
        : [];
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const total = steps.length;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    yield { type: "step-started", command: step.command, args: step.args, index, total };
    let exitCode: number | null = null;
    try {
      for await (const out of runCommand(step.command, step.args)) {
        if (out.kind === "exit") {
          exitCode = out.exitCode ?? null;
          continue;
        }
        if (out.kind === "stdout" || out.kind === "stderr") {
          yield { type: "step-output", stream: out.kind, text: out.text ?? "" };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, step }, "Install step threw");
      yield { type: "step-completed", command: step.command, exitCode: null };
      yield {
        type: "completed",
        success: false,
        error: `${step.command}: ${message}`,
      };
      return;
    }
    yield { type: "step-completed", command: step.command, exitCode };
    if (exitCode !== 0) {
      yield {
        type: "completed",
        success: false,
        error: `${step.command} exited with code ${exitCode}`,
      };
      return;
    }
  }
  yield { type: "completed", success: true };
}

async function* defaultRunCommand(command: string, args: string[]): AsyncIterable<CommandOutput> {
  const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const queue: CommandOutput[] = [];
  let resolveWaiter: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;
  const wake = () => {
    if (resolveWaiter) {
      const fn = resolveWaiter;
      resolveWaiter = null;
      fn();
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    queue.push({ kind: "stdout", text: chunk.toString() });
    wake();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    queue.push({ kind: "stderr", text: chunk.toString() });
    wake();
  });
  child.on("error", (err) => {
    error = err;
    done = true;
    wake();
  });
  child.on("close", (exitCode) => {
    queue.push({ kind: "exit", exitCode });
    done = true;
    wake();
  });
  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) yield item;
    }
    if (!done) {
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
  }
  if (error) throw error;
}
