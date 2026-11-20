import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
});

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** Files that differ between `from` and `to`; without `to`, the working tree. */
export const diffWatch = defineSubscription({
  name: "diff.watch",
  input: z.object({ cwd: z.string(), from: z.string(), to: z.string().optional() }),
  event: z.object({ type: z.literal("changes"), files: z.array(ChangedFileSchema) }),
});
