import type { StreamItem } from "@/types/stream";
import {
  summarizeToolCallActivity,
  type ToolCallActivitySummary,
} from "@/tool-calls/activity-summary";
import { continuesResponse } from "./turn-membership";
import { findTerminalAssistantGroup } from "./terminal-assistant-group";

export interface CompletedResponseSummary extends ToolCallActivitySummary {
  messageCount: number;
}

export interface CompletedResponseFold {
  responseId: string;
  expanded: boolean;
  anchorPlacement: "before" | "after";
  summary: CompletedResponseSummary;
}

export interface CompletedResponseFoldProjection {
  tail: StreamItem[];
  head: StreamItem[];
  foldsByAnchorItemId: ReadonlyMap<string, CompletedResponseFold>;
  intermediateAssistantItemIds: ReadonlySet<string>;
}

type CachedActiveTailProjection = Pick<
  CompletedResponseFoldProjection,
  "tail" | "foldsByAnchorItemId" | "intermediateAssistantItemIds"
>;

interface ToolCallGroupSummaryLookup {
  get(itemId: string): { summary: ToolCallActivitySummary } | undefined;
}

interface CachedLeadingPolicyProjections {
  foldedLeading?: CachedActiveTailProjection;
  preservedLeading?: CachedActiveTailProjection;
}

const activeTailProjectionCache = new WeakMap<
  StreamItem[],
  WeakMap<object, WeakMap<object, CachedLeadingPolicyProjections>>
>();
const EMPTY_COMPLETED_RESPONSE_FOLDS = new Map<string, CompletedResponseFold>();
const EMPTY_INTERMEDIATE_ASSISTANT_ITEM_IDS = new Set<string>();
const EMPTY_TOOL_CALL_GROUP_SUMMARIES = new Map<string, { summary: ToolCallActivitySummary }>();

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

function summarizeFoldableToolCalls(
  calls: readonly Extract<StreamItem, { kind: "tool_call" }>[],
  groupsByHostId: ToolCallGroupSummaryLookup,
): ToolCallActivitySummary {
  let toolCallCount = 0;
  const iconNames = new Set<ToolCallActivitySummary["iconNames"][number]>();
  for (const call of calls) {
    const summary = groupsByHostId.get(call.id)?.summary ?? summarizeToolCallActivity([call]);
    toolCallCount += summary.toolCallCount;
    for (const iconName of summary.iconNames) {
      iconNames.add(iconName);
    }
  }
  return { toolCallCount, iconNames: [...iconNames] };
}

function countAssistantMessages(items: readonly StreamItem[]): number {
  const messageIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "assistant_message") {
      messageIds.add(item.blockGroupId ?? item.id);
    }
  }
  return messageIds.size;
}

function findFoldAnchor(input: {
  response: StreamItem[];
  terminalAssistantItemIds: ReadonlySet<string>;
  expanded: boolean;
}): { itemId: string; placement: CompletedResponseFold["anchorPlacement"] } | null {
  const userMessage = input.response.find((item) => item.kind === "user_message");
  if (userMessage) {
    return { itemId: userMessage.id, placement: "after" };
  }

  const firstVisibleItem = input.expanded
    ? input.response[0]
    : input.response.find(
        (item) => input.terminalAssistantItemIds.has(item.id) || isProtectedPresentationItem(item),
      );
  return firstVisibleItem ? { itemId: firstVisibleItem.id, placement: "before" } : null;
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
  preserveLeadingResponse: boolean;
  toolCallGroupsByHostId: ToolCallGroupSummaryLookup;
}): CompletedResponseFoldProjection {
  const responses = partitionVisibleResponses([...input.tail, ...input.head]);
  const removedItemIds = new Set<string>();
  const foldsByAnchorItemId = new Map<string, CompletedResponseFold>();
  const intermediateAssistantItemIds = new Set<string>();

  for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
    const response = responses[responseIndex];
    if (!response) continue;

    // A mounted history window can start in the middle of a response. Keep that leading response
    // intact until all older rows are mounted so pagination never classifies a partial response.
    if (input.preserveLeadingResponse && responseIndex === 0) continue;

    const isActiveResponse = input.isTurnActive && responseIndex === responses.length - 1;
    if (isActiveResponse) continue;

    const terminalAssistantGroup = findTerminalAssistantGroup(response);
    if (!terminalAssistantGroup) continue;

    const foldableItems = response.filter(
      (item) => !terminalAssistantGroup.itemIds.has(item.id) && !isProtectedPresentationItem(item),
    );
    if (foldableItems.length === 0) continue;

    const expanded = input.expandedResponseIds.has(terminalAssistantGroup.anchorItemId);
    const foldAnchor = findFoldAnchor({
      response,
      terminalAssistantItemIds: terminalAssistantGroup.itemIds,
      expanded,
    });
    if (!foldAnchor) continue;
    const toolCalls = foldableItems.filter(
      (item): item is Extract<StreamItem, { kind: "tool_call" }> => item.kind === "tool_call",
    );
    foldsByAnchorItemId.set(foldAnchor.itemId, {
      responseId: terminalAssistantGroup.anchorItemId,
      expanded,
      anchorPlacement: foldAnchor.placement,
      summary: {
        ...summarizeFoldableToolCalls(toolCalls, input.toolCallGroupsByHostId),
        messageCount: countAssistantMessages(foldableItems),
      },
    });
    for (const item of foldableItems) {
      if (item.kind === "assistant_message") {
        intermediateAssistantItemIds.add(item.id);
      }
    }

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
      intermediateAssistantItemIds,
    };
  }

  return {
    tail: input.tail.filter((item) => !removedItemIds.has(item.id)),
    head: input.head.filter((item) => !removedItemIds.has(item.id)),
    foldsByAnchorItemId,
    intermediateAssistantItemIds,
  };
}

function getActiveTailProjection(
  tail: StreamItem[],
  expandedResponseIds: ReadonlySet<string>,
  preserveLeadingResponse: boolean,
  toolCallGroupsByHostId: ToolCallGroupSummaryLookup,
): CachedActiveTailProjection {
  let cacheByExpansion = activeTailProjectionCache.get(tail);
  if (!cacheByExpansion) {
    cacheByExpansion = new WeakMap();
    activeTailProjectionCache.set(tail, cacheByExpansion);
  }

  const expansionKey = expandedResponseIds as object;
  let cacheByToolCallGroups = cacheByExpansion.get(expansionKey);
  if (!cacheByToolCallGroups) {
    cacheByToolCallGroups = new WeakMap();
    cacheByExpansion.set(expansionKey, cacheByToolCallGroups);
  }
  const toolCallGroupsKey = toolCallGroupsByHostId as object;
  const cachedByLeadingPolicy = cacheByToolCallGroups.get(toolCallGroupsKey);
  const cacheKey = preserveLeadingResponse ? "preservedLeading" : "foldedLeading";
  const cached = cachedByLeadingPolicy?.[cacheKey];
  if (cached) return cached;

  const projected = projectResponseRows({
    tail,
    head: [],
    isTurnActive: true,
    expandedResponseIds,
    preserveLeadingResponse,
    toolCallGroupsByHostId,
  });
  const activeTailProjection = {
    tail: projected.tail,
    foldsByAnchorItemId: projected.foldsByAnchorItemId,
    intermediateAssistantItemIds: projected.intermediateAssistantItemIds,
  };
  cacheByToolCallGroups.set(toolCallGroupsKey, {
    ...cachedByLeadingPolicy,
    [cacheKey]: activeTailProjection,
  });
  return activeTailProjection;
}

export function projectCompletedResponseFolds(input: {
  enabled: boolean;
  tail: StreamItem[];
  head: StreamItem[];
  isTurnActive: boolean;
  expandedResponseIds: ReadonlySet<string>;
  preserveLeadingResponse?: boolean;
  toolCallGroupsByHostId?: ToolCallGroupSummaryLookup;
}): CompletedResponseFoldProjection {
  if (!input.enabled) {
    return {
      tail: input.tail,
      head: input.head,
      foldsByAnchorItemId: EMPTY_COMPLETED_RESPONSE_FOLDS,
      intermediateAssistantItemIds: EMPTY_INTERMEDIATE_ASSISTANT_ITEM_IDS,
    };
  }

  // Live head rows normally extend the final tail response. Cache the settled tail projection so
  // each streamed delta does not rebuild long, already-settled history or invalidate its list rows.
  if (input.isTurnActive && !input.head.some((item) => item.kind === "user_message")) {
    const projectedTail = getActiveTailProjection(
      input.tail,
      input.expandedResponseIds,
      input.preserveLeadingResponse ?? false,
      input.toolCallGroupsByHostId ?? EMPTY_TOOL_CALL_GROUP_SUMMARIES,
    );
    return {
      tail: projectedTail.tail,
      head: input.head,
      foldsByAnchorItemId: projectedTail.foldsByAnchorItemId,
      intermediateAssistantItemIds: projectedTail.intermediateAssistantItemIds,
    };
  }

  return projectResponseRows({
    ...input,
    preserveLeadingResponse: input.preserveLeadingResponse ?? false,
    toolCallGroupsByHostId: input.toolCallGroupsByHostId ?? EMPTY_TOOL_CALL_GROUP_SUMMARIES,
  });
}
