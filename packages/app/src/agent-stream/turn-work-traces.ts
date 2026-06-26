import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";

export function isTurnTraceStreamItem(item: StreamItem): boolean {
  return item.kind === "tool_call" || item.kind === "thought" || item.kind === "todo_list";
}

export interface TurnWorkTraceBundle {
  turnKey: string;
  userMessageId: string;
  traceItemIds: ReadonlySet<string>;
  assistantMessageIds: ReadonlySet<string>;
  isInFlight: boolean;
  timing: TurnTiming | null;
  hasTrace: boolean;
}

export interface TurnWorkTraceLayout {
  bundlesByTurnKey: Map<string, TurnWorkTraceBundle>;
  traceItemIdToTurnKey: Map<string, string>;
  userMessageIdToBundle: Map<string, TurnWorkTraceBundle>;
}

function computeTurnTiming(startedAt: Date, items: StreamItem[]): TurnTiming | null {
  if (items.length === 0) {
    return null;
  }
  let completedAt = startedAt;
  for (const item of items) {
    if (item.timestamp.getTime() > completedAt.getTime()) {
      completedAt = item.timestamp;
    }
  }
  return {
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
  };
}

export function deriveTurnWorkTraceLayout(input: {
  items: StreamItem[];
  agentStatus: string;
}): TurnWorkTraceLayout {
  const bundlesByTurnKey = new Map<string, TurnWorkTraceBundle>();
  const traceItemIdToTurnKey = new Map<string, string>();
  const userMessageIdToBundle = new Map<string, TurnWorkTraceBundle>();

  let currentUser: Extract<StreamItem, { kind: "user_message" }> | null = null;
  let currentTurnItems: StreamItem[] = [];
  const turns: Array<{
    user: Extract<StreamItem, { kind: "user_message" }>;
    items: StreamItem[];
  }> = [];

  const flushTurn = () => {
    if (!currentUser) {
      return;
    }
    turns.push({ user: currentUser, items: currentTurnItems });
    currentUser = null;
    currentTurnItems = [];
  };

  for (const item of input.items) {
    if (item.kind === "user_message") {
      flushTurn();
      currentUser = item;
      currentTurnItems = [];
      continue;
    }
    if (!currentUser) {
      continue;
    }
    currentTurnItems.push(item);
  }
  flushTurn();

  const lastTurnIndex = turns.length - 1;
  const isAgentRunning = input.agentStatus === "running";

  for (let index = 0; index < turns.length; index += 1) {
    const { user, items } = turns[index]!;
    const traceIds = new Set<string>();
    const assistantIds = new Set<string>();
    for (const turnItem of items) {
      if (isTurnTraceStreamItem(turnItem)) {
        traceIds.add(turnItem.id);
      }
      if (turnItem.kind === "assistant_message") {
        assistantIds.add(turnItem.id);
      }
    }
    const isInFlight = isAgentRunning && index === lastTurnIndex;
    const hasTrace = traceIds.size > 0;
    const timing = computeTurnTiming(user.timestamp, items);
    const bundle: TurnWorkTraceBundle = {
      turnKey: user.id,
      userMessageId: user.id,
      traceItemIds: traceIds,
      assistantMessageIds: assistantIds,
      isInFlight,
      timing,
      hasTrace,
    };
    bundlesByTurnKey.set(user.id, bundle);
    userMessageIdToBundle.set(user.id, bundle);
    for (const traceId of traceIds) {
      traceItemIdToTurnKey.set(traceId, user.id);
    }
  }

  return {
    bundlesByTurnKey,
    traceItemIdToTurnKey,
    userMessageIdToBundle,
  };
}

/** Completed-turn trace rows render only inside the work-traces panel, not in the main list. */
export function shouldHideCompletedTurnTraceFromMainList(input: {
  itemId: string;
  traceItemIdToTurnKey: Map<string, string>;
  bundlesByTurnKey: Map<string, TurnWorkTraceBundle>;
}): boolean {
  const turnKey = input.traceItemIdToTurnKey.get(input.itemId);
  if (!turnKey) {
    return false;
  }
  const bundle = input.bundlesByTurnKey.get(turnKey);
  if (!bundle || !bundle.hasTrace || bundle.isInFlight) {
    return false;
  }
  return true;
}

export function shouldShowTurnWorkTracesHeader(input: {
  bundle: TurnWorkTraceBundle | undefined;
}): boolean {
  const bundle = input.bundle;
  if (!bundle || !bundle.hasTrace) {
    return false;
  }
  return !bundle.isInFlight;
}

/** True when the work-traces header shows duration; assistant footer should show end timestamp only. */
export function completedTurnFooterShowsTimestampOnly(input: {
  assistantMessageId: string;
  bundlesByTurnKey: Map<string, TurnWorkTraceBundle>;
}): boolean {
  for (const bundle of input.bundlesByTurnKey.values()) {
    if (!bundle.hasTrace || bundle.isInFlight) {
      continue;
    }
    if (bundle.assistantMessageIds.has(input.assistantMessageId)) {
      return true;
    }
  }
  return false;
}

export interface StreamRenderRow {
  key: string;
  kind: "stream_item" | "turn_work_traces_header";
  streamItem?: StreamItem;
  turnKey?: string;
}

export function buildStreamRenderRows(input: {
  items: StreamItem[];
  agentStatus: string;
}): StreamRenderRow[] {
  const layout = deriveTurnWorkTraceLayout({
    items: input.items,
    agentStatus: input.agentStatus,
  });
  const rows: StreamRenderRow[] = [];

  for (const item of input.items) {
    if (
      shouldHideCompletedTurnTraceFromMainList({
        itemId: item.id,
        traceItemIdToTurnKey: layout.traceItemIdToTurnKey,
        bundlesByTurnKey: layout.bundlesByTurnKey,
      })
    ) {
      continue;
    }

    if (item.kind === "user_message") {
      rows.push({ key: item.id, kind: "stream_item", streamItem: item });
      const bundle = layout.userMessageIdToBundle.get(item.id);
      if (shouldShowTurnWorkTracesHeader({ bundle })) {
        rows.push({
          key: `work-traces:${item.id}`,
          kind: "turn_work_traces_header",
          turnKey: item.id,
        });
      }
      continue;
    }

    rows.push({ key: item.id, kind: "stream_item", streamItem: item });
  }

  return rows;
}