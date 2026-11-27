import { getAssistantReply, type StreamItem } from "@/types/stream";

/** The daemon's timeline cursor; the row's anchor stays in the client. */
interface TimelineBoundaryCursor {
  epoch: string;
  seq: number;
}

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelineBoundaryCursor; boundaryMessageId?: string }
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
      boundaryCursor: { epoch: reply.timelineCursor.epoch, seq: reply.timelineCursor.seq },
      ...(reply.messageId ? { boundaryMessageId: reply.messageId } : {}),
    };
  }
  return reply.messageId ? { boundaryMessageId: reply.messageId } : undefined;
}
