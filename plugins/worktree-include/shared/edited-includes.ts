import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The daemon calls this before the app archives a worktree, so the warning can name the copies
// archive would delete: packages/server/src/server/plugins/builtin/worktree-include.ts.
export const editedIncludesRpc = defineRpc({
  name: "edited-includes",
  input: z.object({ worktree: z.string(), source: z.string() }),
  output: z.object({ paths: z.array(z.string()), complete: z.boolean() }).nullable(),
});
