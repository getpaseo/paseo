import type { PluginAttachmentSearchPayload } from "@paseo/plugin";
import type { output as ZodOutput } from "zod";
import { searchIssuesRpc } from "./issues.shared";
import { createLinearIssueSearch } from "./linear";

export async function searchIssues({
  query,
}: ZodOutput<typeof searchIssuesRpc.input>): Promise<PluginAttachmentSearchPayload> {
  const linear = createLinearIssueSearch({ apiKey: process.env.LINEAR_API_KEY ?? "" });
  return linear.search(query);
}
