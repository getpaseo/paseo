import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export function findForkContext(
  contexts: StoredAgentRecord["forkContexts"],
  item: AgentTimelineItem,
  claimed?: Set<string>,
) {
  if (!contexts || item.type !== "user_message") return undefined;
  if (item.clientMessageId) {
    return Object.hasOwn(contexts, item.clientMessageId)
      ? contexts[item.clientMessageId]
      : undefined;
  }
  const candidates = Object.values(contexts);
  const identified = candidates.find(
    (context) => context.providerMessageId && context.providerMessageId === item.messageId,
  );
  if (identified) return identified;
  // Without provider identity, consume each saved submission once per replay. Prefer the
  // complete snapshot when one inherited snapshot contains another's text.
  return candidates
    .filter(
      (context) =>
        !context.providerMessageId &&
        !claimed?.has(context.clientMessageId) &&
        context.attachment.text.length > 0 &&
        item.text.includes(context.attachment.text) &&
        (!context.text || item.text.includes(context.text)),
    )
    .sort((a, b) => b.attachment.text.length - a.attachment.text.length)[0];
}
