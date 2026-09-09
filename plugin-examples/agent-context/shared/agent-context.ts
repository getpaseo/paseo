import {
  defineAttachmentSource,
  defineRpc,
  PluginAttachmentSearchPayloadSchema,
} from "@getpaseo/plugin";
import { z } from "zod";

export const searchAgentTranscriptsRpc = defineRpc({
  name: "agent-context.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const agentTranscriptAttachments = defineAttachmentSource({
  id: "agent-transcripts",
  title: "agent transcript",
  icon: "MessagesSquare",
  pickerTitle: "Attach agent transcript",
  searchPlaceholder: "Search agents",
  search: searchAgentTranscriptsRpc,
});
