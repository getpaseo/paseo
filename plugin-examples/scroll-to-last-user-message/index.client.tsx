import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  client.addTimelineButton({
    id: "scroll-to-last-user-message",
    button: {
      title: "Scroll to last user message",
      icon: "ChevronUp",
      behavior: { kind: "timeline", target: "last-user-message" },
    },
  });
  return () => {};
}
