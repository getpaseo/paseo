import type { StreamItem } from "@/types/stream";

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
  const item = input.items[input.startIndex];
  if (item?.kind !== "assistant_message") {
    return undefined;
  }
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: { epoch: item.timelineCursor.epoch, seq: item.timelineCursor.seq },
      ...(item.messageId ? { boundaryMessageId: item.messageId } : {}),
    };
  }
  return item.messageId ? { boundaryMessageId: item.messageId } : undefined;
}
