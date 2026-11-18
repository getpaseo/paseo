import type { PluginServerContext } from "@getpaseo/plugin/server";
import { copyWorktreeIncludes, findEditedWorktreeIncludes } from "./server/copy.js";
import { editedIncludesRpc } from "./shared/edited-includes.js";

export default function contribute(server: PluginServerContext) {
  server.handle(editedIncludesRpc, ({ worktree, source }) =>
    findEditedWorktreeIncludes(worktree, source),
  );
  return server.addHook("worktree.create.after", async ({ worktree }) => {
    await copyWorktreeIncludes(worktree.path, worktree.sourceCheckout);
  });
}
