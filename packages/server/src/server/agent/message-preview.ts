import type { AgentMessagePreview } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

/**
 * The newest messages kept in the agent record so History can match what was
 * said, not only the title. The record is rewritten on every state event, so
 * both numbers stay small: five messages of at most 500 characters each.
 */
export const MESSAGE_PREVIEW_LIMIT = 5;
export const MESSAGE_PREVIEW_TEXT_LIMIT = 500;

export type { AgentMessagePreview };

type MessageTimelineItem = Extract<
  AgentTimelineItem,
  { type: "user_message" } | { type: "assistant_message" }
>;

export function isMessageTimelineItem(item: AgentTimelineItem): item is MessageTimelineItem {
  return item.type === "user_message" || item.type === "assistant_message";
}

/** Collapse whitespace and cut on a character budget, marking the cut. */
/** Collapse whitespace runs and cut on a character budget, marking the cut. */
export function capMessagePreviewText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MESSAGE_PREVIEW_TEXT_LIMIT) {
    return collapsed;
  }
  return `${collapsed.slice(0, MESSAGE_PREVIEW_TEXT_LIMIT - 1)}…`;
}

/**
 * The same bound, without trimming the end: a streamed reply is joined chunk by
 * chunk, and trimming each chunk would fuse "the " with whatever follows. The
 * stored copy is trimmed when it is projected.
 */
function capStreamingPreviewText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= MESSAGE_PREVIEW_TEXT_LIMIT) {
    return collapsed;
  }
  return `${collapsed.slice(0, MESSAGE_PREVIEW_TEXT_LIMIT - 1)}…`;
}

/** Providers stream a reply in chunks; drop the previous ellipsis before joining. */
function joinPreviewText(previousText: string, chunkText: string): string {
  const trimmed = previousText.endsWith("…") ? previousText.slice(0, -1) : previousText;
  return `${trimmed}${chunkText}`;
}

/**
 * Fold one recorded message into the preview, oldest first.
 *
 * This is deliberately incremental: providers can emit hundreds of tool or
 * reasoning items between two messages, so rebuilding from a bounded slice of
 * the timeline would drop the question that is still the newest thing asked.
 * `previousItem` is the timeline item recorded just before this one, which is
 * what decides whether an assistant item continues the same reply.
 */
export function appendMessagePreview(
  preview: readonly AgentMessagePreview[],
  item: MessageTimelineItem,
  previousItem: AgentTimelineItem | undefined,
): AgentMessagePreview[] {
  const role = item.type === "user_message" ? "user" : "assistant";
  const last = preview.at(-1);
  // Same boundary as TimelineProjection.mergeAssistantChunks: a new messageId
  // is a new reply. Joining it would fill the 500-character cap and hide it.
  const continuesReply =
    role === "assistant" &&
    previousItem?.type === "assistant_message" &&
    last?.role === "assistant" &&
    (item.messageId === undefined || previousItem.messageId === item.messageId);
  const next: AgentMessagePreview =
    role === "assistant"
      ? {
          role,
          text: capStreamingPreviewText(
            continuesReply ? joinPreviewText(last.text, item.text) : item.text,
          ),
        }
      : { role, text: capMessagePreviewText(item.text) };
  return [...(continuesReply ? preview.slice(0, -1) : preview), next].slice(-MESSAGE_PREVIEW_LIMIT);
}

/**
 * Fold a whole timeline into a preview. Only for the paths that replace the
 * timeline or recover from a failed read: it walks every item, where the append
 * path reads just the one item it is recording.
 */
export function buildMessagePreview(items: readonly AgentTimelineItem[]): AgentMessagePreview[] {
  let preview: AgentMessagePreview[] = [];
  let previousItem: AgentTimelineItem | undefined;
  for (const item of items) {
    if (isMessageTimelineItem(item)) {
      preview = appendMessagePreview(preview, item, previousItem);
    }
    previousItem = item;
  }
  return preview;
}

/**
 * The excerpt a History row shows, newest message first, anchored on the tokens
 * that only a message matched. Returns null when no message carries one.
 */
export function messagePreviewSnippet(
  tokens: readonly string[],
  preview: readonly AgentMessagePreview[],
  limit = 160,
): AgentMessagePreview | null {
  if (tokens.length === 0) {
    return null;
  }

  for (const message of preview.toReversed()) {
    const haystack = message.text.toLowerCase();
    const token = tokens.find((candidate) => haystack.includes(candidate));
    if (token === undefined) {
      continue;
    }
    const start = haystack.indexOf(token);
    // Keep the match inside the window: normally 40 characters of lead-in, but
    // anchor the window to the match when the lead-in would push it out.
    const head = Math.max(0, start - 40);
    const from = Math.max(0, Math.min(head, start + token.length - limit));
    const to = Math.min(message.text.length, from + limit);
    const prefix = from > 0 ? "…" : "";
    const suffix = to < message.text.length ? "…" : "";
    return { role: message.role, text: `${prefix}${message.text.slice(from, to)}${suffix}` };
  }

  return null;
}
