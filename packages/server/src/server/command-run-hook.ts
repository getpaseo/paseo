import type { PrepareWorktreeLifecycleCommand } from "../utils/worktree.js";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";

/** Runs plugins' `command.run.before` hooks for each setup or teardown command. */
export function commandRunHook(
  lifecycle: Pick<PluginLifecycle, "before"> | null,
  scope: { workspaceId: string | null; cwd: string; purpose: "setup" | "teardown" },
): PrepareWorktreeLifecycleCommand | undefined {
  if (!lifecycle) return undefined;
  return async ({ command, env }) => {
    const request = await lifecycle.before("command.run.before", { ...scope, command, env });
    return { command: request.command, env: request.env };
  };
}
