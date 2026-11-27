import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const IssueSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The branch the issue's work goes on. */
  branch: z.string(),
});

export type Issue = z.infer<typeof IssueSchema>;

export const searchIssuesRpc = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: z.object({ issues: z.array(IssueSchema) }),
});
