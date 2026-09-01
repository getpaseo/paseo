import { z } from "zod";

export const commitDiffStateSchema = z.strictObject({
  collapsedFilePaths: z.array(z.string()),
});

export type CommitDiffState = z.infer<typeof commitDiffStateSchema>;

export const defaultCommitDiffState: CommitDiffState = {
  collapsedFilePaths: [],
};
