import type { AcceptedUserMessage } from "./agent-storage.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

type TimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }>;

export function restoreAcceptedUserMessages(
  events: readonly TimelineEvent[],
  messages: readonly AcceptedUserMessage[],
  provider: TimelineEvent["provider"],
  retainUnmatched: boolean,
): { events: TimelineEvent[]; retainedIds: Set<string> } {
  const retainedIds = new Set<string>();
  const restored = events.map((event): TimelineEvent => {
    if (event.item.type !== "user_message") return event;
    const item = event.item;
    const accepted = messages.find((message) =>
      Boolean(
        (item.clientMessageId && item.clientMessageId === message.item.clientMessageId) ||
        (item.messageId &&
          (item.messageId === message.providerMessageId ||
            item.messageId === message.item.messageId)),
      ),
    );
    if (!accepted) return event;
    retainedIds.add(accepted.item.clientMessageId);
    return {
      ...event,
      timestamp: event.timestamp ?? accepted.timestamp,
      item: { ...item, ...accepted.item, messageId: item.messageId ?? accepted.item.messageId },
    };
  });
  if (retainUnmatched) {
    for (const message of messages) {
      if (retainedIds.has(message.item.clientMessageId)) continue;
      retainedIds.add(message.item.clientMessageId);
      const event: TimelineEvent = {
        type: "timeline",
        provider,
        item: message.item,
        timestamp: message.timestamp,
        ...(message.turnId ? { turnId: message.turnId } : {}),
      };
      const insertion = restored.findIndex((entry) =>
        entry.timestamp ? entry.timestamp > message.timestamp : false,
      );
      if (insertion < 0) restored.push(event);
      else restored.splice(insertion, 0, event);
    }
  }
  return { events: restored, retainedIds };
}
