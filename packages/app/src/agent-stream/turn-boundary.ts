import { getAssistantReply, type StreamItem, type TimelinePosition } from "@/types/stream";

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
  if (input.supportsTimelineCursor && reply.timelineCursor) {
    return {
      boundaryCursor: reply.timelineCursor,
      ...(reply.messageId ? { boundaryMessageId: reply.messageId } : {}),
    };
  }
  return reply.messageId ? { boundaryMessageId: reply.messageId } : undefined;
}
