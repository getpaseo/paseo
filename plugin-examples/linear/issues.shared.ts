import { defineAttachmentSource, defineRpc } from "@paseo/plugin";
import { z } from "zod";

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

export const searchIssuesRpc = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: SearchPayloadSchema,
});

export const issueAttachments = defineAttachmentSource({
  id: "issues",
  title: "Linear issue",
  icon: "CircleDot",
  pickerTitle: "Attach Linear issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssuesRpc,
});
