import type { PluginLifecycle } from "../server/plugins/lifecycle/index.js";
import { applyLaunchWrap } from "../utils/launch-wrap.js";
import { resolveDefaultTerminalShell } from "./default-terminal-shell.js";
import type { DaemonTerminalManager } from "./worker-terminal-manager.js";

/**
 * Runs plugins' `terminal.create.before` hooks for every terminal the daemon creates, before the
 * worker starts it. A selected wrap becomes the terminal's program here, so the worker protocol
 * does not change. Terminals adopted after a daemon restart aren't created again, so the hook
 * doesn't run for them.
 */
export function withTerminalCreateHook(
  manager: DaemonTerminalManager,
  lifecycle: Pick<PluginLifecycle, "before">,
): DaemonTerminalManager {
  return {
    ...manager,
    async createTerminal({ origin, ...options }) {
      const args = options.args ?? [];
      const request = await lifecycle.before("terminal.create.before", {
        workspaceId: options.workspaceId,
        cwd: options.cwd,
        source: origin?.source ?? "client",
        name: options.name ?? null,
        command: options.command ?? null,
        args,
        input: origin?.input ?? null,
        env: options.env ?? {},
      });
      if (!request.wrap) return manager.createTerminal({ ...options, env: request.env });
      const command = options.command ?? resolveDefaultTerminalShell({ env: options.baseEnv });
      const launch = applyLaunchWrap({ command, args }, request.wrap);
      return manager.createTerminal({ ...options, env: request.env, ...launch });
    },
  };
}
