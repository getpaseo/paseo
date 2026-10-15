import type { StreamItem } from "@/types/stream";
import { startsNewTurn } from "@/agent-stream/turn-membership";

export interface TurnTiming {
  completedAt: Date;
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byResponseItemId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  const byResponseItemId = new Map<string, TurnTiming>();
  let currentUserAt: Date | null = null;
  let currentLastItemAt: Date | null = null;
  let currentResponseItemIds: string[] = [];
  let previousItem: StreamItem | null = null;

  const flushCompletedTurn = () => {
    if (!currentLastItemAt || currentResponseItemIds.length === 0) {
      return;
    }
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    for (const id of currentResponseItemIds) {
      byResponseItemId.set(id, timing);
    }
  };

  const visitItem = (item: StreamItem) => {
    if (startsNewTurn(item, previousItem)) {
      flushCompletedTurn();
      currentUserAt = item.kind === "user_message" ? item.timestamp : null;
      currentLastItemAt = null;
      currentResponseItemIds = [];
    }
    currentLastItemAt = item.timestamp;
    if (
      item.kind === "assistant_message" ||
      (item.kind === "notification" && item.sourceType === "error")
    ) {
      currentResponseItemIds.push(item.id);
    }
    previousItem = item;
  };

  for (const item of params.tail) {
    visitItem(item);
  }
  for (const item of params.head) {
    visitItem(item);
  }

  const runningStartedAt = params.isTurnActive ? params.activeTurnStartedAt : null;
  if (!params.isTurnActive) {
    flushCompletedTurn();
  }

  return {
    byResponseItemId,
    runningStartedAt,
  };
}
