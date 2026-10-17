import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MathMessage, mathMessageSchema } from "./client/math-message";
import { hasMath, splitMathSegments } from "./shared/math";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "math-render",
    query: { itemType: "assistant_message" },
    transform: ({ item }) => {
      // Leave messages without math to the host: replacing an item costs the
      // host's markdown rendering for that message.
      if (!hasMath(item.text)) return undefined;
      return {
        items: [
          {
            type: "plugin",
            kind: "math-message",
            version: 1,
            data: { segments: splitMathSegments(item.text) },
          },
        ],
      };
    },
  });
  client.addTimelineRenderer({
    kind: "math-message",
    version: 1,
    schema: mathMessageSchema,
    Component: MathMessage,
  });
  return () => {};
}
