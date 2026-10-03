import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchContext } from "./shared/context";

const item = {
  id: "sample",
  identifier: "Sample",
  title: "Example conversation",
  url: "https://example.invalid/conversation",
  text: "[User] Example context\n[Assistant] Example response",
  resourceType: "conversation",
  contextKind: "chat_history" as const,
};

export default function contribute(server: PluginServerContext) {
  server.handle(searchContext, ({ query }) => ({
    items: item.title.toLowerCase().includes(query.toLowerCase()) ? [item] : [],
  }));
  return () => {};
}
