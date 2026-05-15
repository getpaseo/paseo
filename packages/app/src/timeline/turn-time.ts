import type { StreamItem, TurnHeaderItem, TurnHeaderOutcome } from "@/types/stream";

export function appendLiveTurnHeader(state: StreamItem[], startedAt: Date): StreamItem[] {
  const lastHeader = findLastTurnHeader(state);
  if (lastHeader && lastHeader.completedAt === undefined) {
    return state;
  }
  const header: TurnHeaderItem = {
    kind: "turn_header",
    id: `turn_${startedAt.getTime()}_${state.length.toString(36)}`,
    timestamp: startedAt,
    startedAt,
    source: "live",
  };
  return [...state, header];
}

export function completeLastTurnHeader(
  state: StreamItem[],
  completedAt: Date,
  outcome: TurnHeaderOutcome,
): StreamItem[] {
  for (let i = state.length - 1; i >= 0; i -= 1) {
    const item = state[i];
    if (item?.kind !== "turn_header") {
      continue;
    }
    if (item.completedAt !== undefined) {
      return state;
    }
    const updated: TurnHeaderItem = {
      ...item,
      completedAt,
      durationMs: Math.max(0, completedAt.getTime() - item.startedAt.getTime()),
      outcome,
    };
    const next = [...state];
    next[i] = updated;
    return next;
  }
  return state;
}

export function synthesizeMissingTurnHeaders(state: StreamItem[]): StreamItem[] {
  const result: StreamItem[] = [];
  let segment: StreamItem[] = [];
  let needsHeader = true;

  function flushSegment() {
    if (segment.length === 0) {
      return;
    }
    if (needsHeader) {
      const first = segment[0];
      const last = segment[segment.length - 1];
      const startedAt = first.timestamp;
      const completedAt = last.timestamp;
      const header: TurnHeaderItem = {
        kind: "turn_header",
        id: `turn_derived_${startedAt.getTime()}_${result.length.toString(36)}`,
        timestamp: startedAt,
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        outcome: "completed",
        source: "derived",
      };
      result.push(header);
    }
    result.push(...segment);
    segment = [];
  }

  for (const item of state) {
    if (item.kind === "user_message") {
      flushSegment();
      needsHeader = true;
      result.push(item);
      continue;
    }
    if (item.kind === "turn_header") {
      flushSegment();
      needsHeader = false;
      result.push(item);
      continue;
    }
    segment.push(item);
  }

  flushSegment();
  return result;
}

export function findInFlightTurnStartedAt(params: {
  agentStatus: string;
  liveHead: StreamItem[];
  tail: StreamItem[];
}): Date | null {
  if (params.agentStatus !== "running") {
    return null;
  }
  const headStartedAt = findLastOpenTurnHeader(params.liveHead)?.startedAt;
  if (headStartedAt) {
    return headStartedAt;
  }
  return findLastOpenTurnHeader(params.tail)?.startedAt ?? null;
}

export interface TurnHeaderNeighborResolver {
  getNeighborIndex(index: number, relation: "above" | "below"): number;
}

export function findTurnHeaderForAssistantTurn(params: {
  strategy: TurnHeaderNeighborResolver;
  items: StreamItem[];
  startIndex: number;
}): TurnHeaderItem | null {
  let index = params.startIndex;
  while (index >= 0 && index < params.items.length) {
    const item = params.items[index];
    if (!item) return null;
    if (item.kind === "turn_header") return item;
    if (item.kind === "user_message") return null;
    index = params.strategy.getNeighborIndex(index, "above");
  }
  return null;
}

function findLastTurnHeader(state: StreamItem[]): TurnHeaderItem | null {
  for (let i = state.length - 1; i >= 0; i -= 1) {
    const item = state[i];
    if (item?.kind === "turn_header") {
      return item;
    }
  }
  return null;
}

function findLastOpenTurnHeader(state: StreamItem[]): TurnHeaderItem | null {
  for (let i = state.length - 1; i >= 0; i -= 1) {
    const item = state[i];
    if (item?.kind === "turn_header" && item.completedAt === undefined) {
      return item;
    }
  }
  return null;
}
