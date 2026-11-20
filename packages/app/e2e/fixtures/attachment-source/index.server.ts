import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchContext } from "./shared/context";

const item = {
  id: "agent_a1b2c3d4-1a2b-3c4d-5e6f-123456789abc",
  identifier: "a1b2c3d4",
  title:
    "Example conversation about revising the workspace attachment picker so provenance stays visible even when an agent has a very long tab title",
  subtitle: "Example workspace",
  url: "https://example.invalid/conversation",
  text: "[User] Example context\n[Assistant] Example response",
  resourceType: "conversation",
  contextKind: "chat_history" as const,
};

export default function contribute(server: PluginServerContext) {
  server.handle(searchContext, ({ query }) => {
    const matches = [item.title, item.subtitle, item.id].some((value) =>
      value.toLowerCase().includes(query.toLowerCase()),
    );
    return { items: matches ? [item] : [] };
  });
  return () => {};
}
