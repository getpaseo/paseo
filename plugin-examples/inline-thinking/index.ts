import type { PluginContext } from "@getpaseo/plugin";
import { InlineThinking, inlineThinkingSchema } from "./thinking.client";

export default function contribute(plugin: PluginContext) {
  plugin.addTimelineTransformer({
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
  plugin.addTimelineRenderer({
    kind: "inline-thinking",
    version: 1,
    schema: inlineThinkingSchema,
    Component: InlineThinking,
  });
  return () => {};
}
