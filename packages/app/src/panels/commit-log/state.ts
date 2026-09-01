import { z } from "zod";

export const commitLogStateSchema = z.strictObject({
  scope: z.enum(["head", "all"]),
});

export type CommitLogState = z.infer<typeof commitLogStateSchema>;

export const defaultCommitLogState: CommitLogState = {
  scope: "head",
};
