import { z } from "zod";
import {
  defineAttachmentSource,
  defineRpc,
  type PluginAttachmentSearchPayload,
  type PluginContext,
} from "@paseo/plugin";
import { createLinearIssueSearch } from "./linear";

const SearchPayloadSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
      url: z.string().url(),
      text: z.string(),
      resourceType: z.string(),
    }),
  ),
});

const searchIssues = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: SearchPayloadSchema,
});

const issueAttachments = defineAttachmentSource({
  id: "issues",
  title: "Linear issue",
  icon: "CircleDot",
  pickerTitle: "Attach Linear issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});

export default function contribute(plugin: PluginContext) {
  plugin.handle(searchIssues, async ({ query }): Promise<PluginAttachmentSearchPayload> => {
    const linear = createLinearIssueSearch({ apiKey: process.env.LINEAR_API_KEY ?? "" });
    return linear.search(query);
  });
  plugin.addAttachmentSource(issueAttachments);
  return () => undefined;
}
