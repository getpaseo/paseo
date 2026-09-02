import type { PluginClientContext } from "@getpaseo/plugin";
import { InlineThinking, inlineThinkingSchema } from "./client/thinking";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "inline-thinking",
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => ({
      items: [
        {
          type: "plugin",
          kind: "inline-thinking",
          version: 1,
          data: { text: item.text, phase },
        },
      ],
    }),
  });
  client.addTimelineRenderer({
    kind: "inline-thinking",
    version: 1,
    schema: inlineThinkingSchema,
    Component: InlineThinking,
  });
  return () => {};
}
