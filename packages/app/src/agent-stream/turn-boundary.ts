import { isAssistantReplyItem, type StreamItem, type TimelinePosition } from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const item = input.items[input.startIndex];
  if (!isAssistantReplyItem(item)) {
    return undefined;
  }
  const messageId = item.kind === "assistant_message" ? item.messageId : item.sourceMessageId;
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(messageId ? { boundaryMessageId: messageId } : {}),
    };
  }
  return messageId ? { boundaryMessageId: messageId } : undefined;
}
