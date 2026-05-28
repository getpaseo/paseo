import type { StreamItem } from "@/types/stream";

export interface TurnTiming {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export interface StreamTurnTiming {
  byAssistantId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

export function deriveStreamTurnTiming(params: {
  agentStatus: string;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  const byAssistantId = new Map<string, TurnTiming>();
  let currentUserAt: Date | null = null;
  let currentLastItemAt: Date | null = null;
  let currentAssistantIds: string[] = [];

  const flushCompletedTurn = () => {
    if (!currentUserAt || !currentLastItemAt || currentAssistantIds.length === 0) {
      return;
    }
    const timing: TurnTiming = {
      startedAt: currentUserAt,
      completedAt: currentLastItemAt,
      durationMs: Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime()),
    };
    for (const id of currentAssistantIds) {
      byAssistantId.set(id, timing);
    }
  };

  const visitItem = (item: StreamItem) => {
    if (item.kind === "user_message") {
      flushCompletedTurn();
      currentUserAt = item.timestamp;
      currentLastItemAt = null;
      currentAssistantIds = [];
      return;
    }
    if (!currentUserAt) {
      return;
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      currentAssistantIds.push(item.id);
    }
  };

  for (const item of params.tail) {
    visitItem(item);
  }
  for (const item of params.head) {
    visitItem(item);
  }

  const runningStartedAt =
    params.agentStatus === "running"
      ? (findLastUserMessageTimestamp(params.head) ?? currentUserAt)
      : null;
  if (params.agentStatus !== "running") {
    flushCompletedTurn();
  }

  return {
    byAssistantId,
    runningStartedAt,
  };
}

function findLastUserMessageTimestamp(items: StreamItem[]): Date | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "user_message") {
      return item.timestamp;
    }
  }
  return null;
}
