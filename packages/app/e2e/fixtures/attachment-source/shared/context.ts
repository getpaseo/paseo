import {
  defineAttachmentSource,
  defineRpc,
  PluginAttachmentSearchPayloadSchema,
} from "@getpaseo/plugin";
import { z } from "zod";

export const searchContext = defineRpc({
  name: "context.search",
  input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});

export const contextAttachments = defineAttachmentSource({
  id: "context",
  title: "Conversation context",
  icon: "MessagesSquare",
  pickerTitle: "Attach example conversation",
  searchPlaceholder: "Search conversations",
  newAgentShortcut: true,
  crossHost: true,
  search: searchContext,
});
