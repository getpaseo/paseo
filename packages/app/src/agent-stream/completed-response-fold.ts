import type { StreamItem } from "@/types/stream";
import { continuesResponse } from "./turn-membership";

export interface CompletedResponseFold {
  responseId: string;
  expanded: boolean;
}

export interface CompletedResponseFoldProjection {
  tail: StreamItem[];
  head: StreamItem[];
  foldsByAnchorItemId: ReadonlyMap<string, CompletedResponseFold>;
}

type CachedActiveTailProjection = Pick<
  CompletedResponseFoldProjection,
  "tail" | "foldsByAnchorItemId"
>;

const activeTailProjectionCache = new WeakMap<
  StreamItem[],
  WeakMap<object, CachedActiveTailProjection>
>();

function isToolCallRunning(item: Extract<StreamItem, { kind: "tool_call" }>): boolean {
  return item.payload.data.status === "running" || item.payload.data.status === "executing";
}

/** Rows that must remain independently actionable or visible when response work is folded. */
function isProtectedPresentationItem(item: StreamItem): boolean {
  if (item.kind === "user_message") {
    return true;
  }
  if (item.kind === "activity_log" && item.activityType === "error") {
    return true;
  }
  return item.kind === "tool_call" && isToolCallRunning(item);
}

function findTerminalAssistantIndex(response: StreamItem[]): number | null {
  let assistantIndex: number | null = null;
  let lastWorkIndex = -1;

  for (let index = 0; index < response.length; index += 1) {
    const item = response[index];
    if (!item) continue;
    if (item.kind === "assistant_message") {
      assistantIndex = index;
    } else if (item.kind === "thought" || item.kind === "tool_call" || item.kind === "todo_list") {
      lastWorkIndex = index;
    }
  }

  if (assistantIndex === null || assistantIndex < lastWorkIndex) {
    return null;
  }
  return assistantIndex;
}

function partitionVisibleResponses(items: StreamItem[]): StreamItem[][] {
  const responses: StreamItem[][] = [];
  let current: StreamItem[] = [];

  for (const item of items) {
    const previous = current.at(-1) ?? null;
    if (previous && !continuesResponse(previous, item)) {
      responses.push(current);
      current = [];
    }
    current.push(item);
  }

  if (current.length > 0) {
    responses.push(current);
  }
  return responses;
}

/**
 * Builds a reversible presentation-only projection for settled responses.
 * Canonical stream rows are never mutated or discarded from the session store.
 */
function projectResponseRows(input: {
  tail: StreamItem[];
  head: StreamItem[];
  isTurnActive: boolean;
  expandedResponseIds: ReadonlySet<string>;
}): CompletedResponseFoldProjection {
  const responses = partitionVisibleResponses([...input.tail, ...input.head]);
  const removedItemIds = new Set<string>();
  const foldsByAnchorItemId = new Map<string, CompletedResponseFold>();

  for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
    const response = responses[responseIndex];
    if (!response) continue;

    const isActiveResponse = input.isTurnActive && responseIndex === responses.length - 1;
    if (isActiveResponse) continue;

    const terminalAssistantIndex = findTerminalAssistantIndex(response);
    if (terminalAssistantIndex === null) continue;

    const terminalAssistant = response[terminalAssistantIndex];
    if (!terminalAssistant || terminalAssistant.kind !== "assistant_message") continue;

    const foldableItems = response.filter(
      (item, index) => index !== terminalAssistantIndex && !isProtectedPresentationItem(item),
    );
    if (foldableItems.length === 0) continue;

    const expanded = input.expandedResponseIds.has(terminalAssistant.id);
    foldsByAnchorItemId.set(terminalAssistant.id, {
      responseId: terminalAssistant.id,
      expanded,
    });

    if (!expanded) {
      for (const item of foldableItems) {
        removedItemIds.add(item.id);
      }
    }
  }

  if (removedItemIds.size === 0) {
    return {
      tail: input.tail,
      head: input.head,
      foldsByAnchorItemId,
    };
  }

  return {
    tail: input.tail.filter((item) => !removedItemIds.has(item.id)),
    head: input.head.filter((item) => !removedItemIds.has(item.id)),
    foldsByAnchorItemId,
  };
}

function getActiveTailProjection(
  tail: StreamItem[],
  expandedResponseIds: ReadonlySet<string>,
): CachedActiveTailProjection {
  let cacheByExpansion = activeTailProjectionCache.get(tail);
  if (!cacheByExpansion) {
    cacheByExpansion = new WeakMap();
    activeTailProjectionCache.set(tail, cacheByExpansion);
  }

  const expansionKey = expandedResponseIds as object;
  const cached = cacheByExpansion.get(expansionKey);
  if (cached) return cached;

  const projected = projectResponseRows({
    tail,
    head: [],
    isTurnActive: true,
    expandedResponseIds,
  });
  const activeTailProjection = {
    tail: projected.tail,
    foldsByAnchorItemId: projected.foldsByAnchorItemId,
  };
  cacheByExpansion.set(expansionKey, activeTailProjection);
  return activeTailProjection;
}

export function projectCompletedResponseFolds(input: {
  tail: StreamItem[];
  head: StreamItem[];
  isTurnActive: boolean;
  expandedResponseIds: ReadonlySet<string>;
}): CompletedResponseFoldProjection {
  // Live head rows normally extend the final tail response. Cache the settled tail projection so
  // each streamed delta does not rebuild long, already-settled history or invalidate its list rows.
  if (input.isTurnActive && !input.head.some((item) => item.kind === "user_message")) {
    const projectedTail = getActiveTailProjection(input.tail, input.expandedResponseIds);
    return {
      tail: projectedTail.tail,
      head: input.head,
      foldsByAnchorItemId: projectedTail.foldsByAnchorItemId,
    };
  }

  return projectResponseRows(input);
}
