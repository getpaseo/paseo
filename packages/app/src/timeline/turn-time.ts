import type { StreamItem } from "@/types/stream";
import { startsNewTurn } from "@/agent-stream/turn-membership";

export interface TurnTiming {
  completedAt: Date;
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byAssistantId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}

interface OpenTurn {
  userAt: Date | null;
  lastItemAt: Date | null;
  assistantIds: readonly string[];
  previousItem: StreamItem | null;
}

interface HeadTurnTiming {
  additions: Map<string, TurnTiming>;
  byAssistantId: Map<string, TurnTiming>;
}

interface TailTurnTiming {
  completed: Map<string, TurnTiming>;
  openTurn: OpenTurn;
  lastHead: HeadTurnTiming | null;
}

const EMPTY_OPEN_TURN: OpenTurn = {
  userAt: null,
  lastItemAt: null,
  assistantIds: [],
  previousItem: null,
};

function closeTurn(turn: OpenTurn, into: Map<string, TurnTiming>): void {
  if (!turn.lastItemAt || turn.assistantIds.length === 0) {
    return;
  }
  const timing: TurnTiming = {
    completedAt: turn.lastItemAt,
    durationMs: turn.userAt ? Math.max(0, turn.lastItemAt.getTime() - turn.userAt.getTime()) : null,
  };
  for (const id of turn.assistantIds) {
    into.set(id, timing);
  }
}

function walkTurns(
  items: readonly StreamItem[],
  from: OpenTurn,
  into: Map<string, TurnTiming>,
): OpenTurn {
  let userAt = from.userAt;
  let lastItemAt = from.lastItemAt;
  let assistantIds = [...from.assistantIds];
  let previousItem = from.previousItem;
  for (const item of items) {
    if (startsNewTurn(item, previousItem)) {
      closeTurn({ userAt, lastItemAt, assistantIds, previousItem }, into);
      userAt = item.kind === "user_message" ? item.timestamp : null;
      lastItemAt = null;
      assistantIds = [];
    }
    lastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      assistantIds.push(item.id);
    }
    previousItem = item;
  }
  return { userAt, lastItemAt, assistantIds, previousItem };
}

function areTimingsEqual(a: Map<string, TurnTiming>, b: Map<string, TurnTiming>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, timing] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.completedAt.getTime() !== timing.completedAt.getTime() ||
      other.durationMs !== timing.durationMs
    ) {
      return false;
    }
  }
  return true;
}

// The tail walk is cached by array identity so a streamed delta, which only replaces the
// head, walks the head from the carried open turn. The returned Map keeps its identity
// while the head adds no completed turn, so memos keyed on it do not miss per tick.
const tailTurnTimingCache = new WeakMap<StreamItem[], TailTurnTiming>();

function getTailTurnTiming(tail: StreamItem[]): TailTurnTiming {
  const cached = tailTurnTimingCache.get(tail);
  if (cached) {
    return cached;
  }
  const completed = new Map<string, TurnTiming>();
  const openTurn = walkTurns(tail, EMPTY_OPEN_TURN, completed);
  const timing: TailTurnTiming = { completed, openTurn, lastHead: null };
  tailTurnTimingCache.set(tail, timing);
  return timing;
}

function resolveByAssistantId(
  tail: TailTurnTiming,
  additions: Map<string, TurnTiming>,
): Map<string, TurnTiming> {
  if (additions.size === 0) {
    return tail.completed;
  }
  if (tail.lastHead && areTimingsEqual(tail.lastHead.additions, additions)) {
    return tail.lastHead.byAssistantId;
  }
  const byAssistantId = new Map(tail.completed);
  for (const [id, timing] of additions) {
    byAssistantId.set(id, timing);
  }
  tail.lastHead = { additions, byAssistantId };
  return byAssistantId;
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  const tail = getTailTurnTiming(params.tail);
  const additions = new Map<string, TurnTiming>();
  const openTurn = walkTurns(params.head, tail.openTurn, additions);
  if (!params.isTurnActive) {
    closeTurn(openTurn, additions);
  }
  return {
    byAssistantId: resolveByAssistantId(tail, additions),
    runningStartedAt: params.isTurnActive ? params.activeTurnStartedAt : null,
  };
}
