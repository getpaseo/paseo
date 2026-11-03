import type { PluginLifecycle } from "../server/plugins/lifecycle/index.js";
import type { DaemonTerminalManager } from "./worker-terminal-manager.js";

/**
 * Runs plugins' `terminal.create.before` hooks for every terminal the daemon creates, before the
 * worker starts it. Terminals adopted after a daemon restart aren't created again, so the hook
 * doesn't run for them.
 */
export function withTerminalCreateHook(
  manager: DaemonTerminalManager,
  lifecycle: Pick<PluginLifecycle, "before">,
): DaemonTerminalManager {
  return {
    ...manager,
    async createTerminal({ origin, ...options }) {
      const request = await lifecycle.before("terminal.create.before", {
        workspaceId: options.workspaceId,
        cwd: options.cwd,
        source: origin?.source ?? "client",
        name: options.name ?? null,
        input: origin?.input ?? null,
        ...(options.command ? { command: options.command } : {}),
        args: options.args ?? [],
        env: options.env ?? {},
      });
      return manager.createTerminal({
        ...options,
        command: request.command,
        args: request.args,
        env: request.env,
      });
    },
  };
}
