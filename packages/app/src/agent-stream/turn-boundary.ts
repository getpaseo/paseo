import {
  getAssistantReply,
  type AssistantMessageItem,
  type StreamItem,
  type TimelinePosition,
} from "@/types/stream";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const reply = getAssistantReply(input.items[input.startIndex]);
  if (!reply) {
    return undefined;
  }
  return resolveAssistantMessageForkBoundary({
    item: reply,
    supportsTimelineCursor: input.supportsTimelineCursor,
  });
}

export function resolveAssistantMessageForkBoundary(input: {
  item: Pick<AssistantMessageItem, "messageId" | "timelineCursor">;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const { item } = input;
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(item.messageId ? { boundaryMessageId: item.messageId } : {}),
    };
  }
  return item.messageId ? { boundaryMessageId: item.messageId } : undefined;
}
