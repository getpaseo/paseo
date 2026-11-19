import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CheckoutEditedIncludesSchema,
  type CheckoutEditedIncludes,
} from "@getpaseo/protocol/messages";

// The worktree-include built-in owns `.worktreeinclude` matching; this is the one place the
// daemon names it. Its contract: plugins/worktree-include/shared/edited-includes.ts.
const PLUGIN_ID = "worktree-include";
const EDITED_INCLUDES_METHOD = "edited-includes";

export interface PluginRpcInvoker {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

/**
 * Asks the worktree-include plugin which include copies in a worktree differ from the main
 * checkout's. Git ignores them, so the archive warning can't see them otherwise. Null when the
 * main checkout has no `.worktreeinclude`; rejects when the plugin isn't running.
 */
export async function readEditedWorktreeIncludes(
  plugins: PluginRpcInvoker,
  input: { worktree: string; mainCheckout: string },
): Promise<CheckoutEditedIncludes | null> {
  const hasIncludeFile = await stat(path.join(input.mainCheckout, ".worktreeinclude")).then(
    (stats) => stats.isFile(),
    () => false,
  );
  if (!hasIncludeFile) return null;
  const output = await plugins.invokePluginRpc(PLUGIN_ID, EDITED_INCLUDES_METHOD, {
    worktree: input.worktree,
    source: input.mainCheckout,
  });
  return CheckoutEditedIncludesSchema.nullable().parse(output);
}
