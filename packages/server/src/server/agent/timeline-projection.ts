import type { AgentTimelineItem, ToolCallDetail } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-manager.js";

export type TimelineProjectionMode = "canonical" | "projected";

export interface TimelineSeqRange {
  startSeq: number;
  endSeq: number;
}

export type TimelineProjectionKind = "assistant_merge" | "reasoning_merge" | "tool_lifecycle";
export type TimelineLimitDirection = "tail" | "before" | "after";

export interface TimelineProjectionEntry {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: TimelineSeqRange[];
  collapsed: TimelineProjectionKind[];
}

type WorkingEntry = TimelineProjectionEntry;
interface ProjectedWindowSelection {
  projectedEntries: TimelineProjectionEntry[];
  selectedRows: AgentTimelineRow[];
  minSeq: number | null;
  maxSeq: number | null;
}

function appendSeqToRanges(ranges: TimelineSeqRange[], seq: number): TimelineSeqRange[] {
  if (ranges.length === 0) {
    return [{ startSeq: seq, endSeq: seq }];
  }

  const next = [...ranges];
  const last = next[next.length - 1];
  if (!last) {
    return [{ startSeq: seq, endSeq: seq }];
  }

  if (seq <= last.endSeq + 1) {
    last.endSeq = Math.max(last.endSeq, seq);
    return next;
  }

  next.push({ startSeq: seq, endSeq: seq });
  return next;
}

function mergeSeqRanges(
  existing: TimelineSeqRange[],
  incoming: TimelineSeqRange[],
): TimelineSeqRange[] {
  let merged = [...existing];
  for (const range of incoming) {
    for (let seq = range.startSeq; seq <= range.endSeq; seq += 1) {
      merged = appendSeqToRanges(merged, seq);
    }
  }
  return merged;
}

function mergeToolCallDetail(existing: ToolCallDetail, incoming: ToolCallDetail): ToolCallDetail {
  if (existing.type === "unknown" && incoming.type !== "unknown") {
    return incoming;
  }
  if (incoming.type === "unknown" && existing.type !== "unknown") {
    return existing;
  }
  return incoming;
}

function mergeToolCallItems(
  existing: Extract<AgentTimelineItem, { type: "tool_call" }>,
  incoming: Extract<AgentTimelineItem, { type: "tool_call" }>,
): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const mergedDetail = mergeToolCallDetail(existing.detail, incoming.detail);
  const mergedMetadata =
    existing.metadata || incoming.metadata
      ? { ...existing.metadata, ...incoming.metadata }
      : undefined;

  const merged: Extract<AgentTimelineItem, { type: "tool_call" }> = {
    ...existing,
    ...incoming,
    detail: mergedDetail,
    metadata: mergedMetadata,
  };

  if (incoming.status === "failed") {
    merged.error = incoming.error;
  } else if (incoming.status === "completed" || incoming.status === "canceled") {
    merged.error = null;
  } else if (incoming.error !== undefined) {
    merged.error = incoming.error;
  }

  return merged;
}

function makeCanonicalEntries(rows: readonly AgentTimelineRow[]): WorkingEntry[] {
  return rows.map((row) => ({
    item: row.item,
    timestamp: row.timestamp,
    seqStart: row.seq,
    seqEnd: row.seq,
    sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }],
    collapsed: [],
  }));
}

function collapseToolLifecycle(entries: readonly WorkingEntry[]): WorkingEntry[] {
  const output: WorkingEntry[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const entry of entries) {
    if (entry.item.type !== "tool_call") {
      output.push(entry);
      continue;
    }

    const existingIndex = toolIndexByCallId.get(entry.item.callId);
    if (existingIndex === undefined) {
      toolIndexByCallId.set(entry.item.callId, output.length);
      output.push(entry);
      continue;
    }

    const existing = output[existingIndex];
    if (!existing || existing.item.type !== "tool_call") {
      output.push(entry);
      continue;
    }

    const mergedItem = mergeToolCallItems(existing.item, entry.item);
    const mergedRanges = mergeSeqRanges(existing.sourceSeqRanges, entry.sourceSeqRanges);
    const collapsed = existing.collapsed.includes("tool_lifecycle")
      ? existing.collapsed
      : ([...existing.collapsed, "tool_lifecycle"] as TimelineProjectionKind[]);

    output[existingIndex] = {
      ...existing,
      item: mergedItem,
      seqEnd: Math.max(existing.seqEnd, entry.seqEnd),
      sourceSeqRanges: mergedRanges,
      collapsed,
    };
  }

  return output;
}

function mergeReasoningChunks(entries: readonly WorkingEntry[]): WorkingEntry[] {
  const output: WorkingEntry[] = [];

  for (const entry of entries) {
    const previous = output[output.length - 1];
    const shouldMerge =
      previous &&
      previous.item.type === "reasoning" &&
      entry.item.type === "reasoning" &&
      previous.seqEnd + 1 === entry.seqStart;

    if (!shouldMerge || !previous) {
      output.push(entry);
      continue;
    }
    const previousReasoning = previous.item as Extract<AgentTimelineItem, { type: "reasoning" }>;
    const entryReasoning = entry.item as Extract<AgentTimelineItem, { type: "reasoning" }>;

    const collapsedKinds = new Set<TimelineProjectionKind>([
      ...previous.collapsed,
      ...entry.collapsed,
      "reasoning_merge",
    ]);

    output[output.length - 1] = {
      ...previous,
      item: {
        type: "reasoning",
        text: `${previousReasoning.text}${entryReasoning.text}`,
      },
      seqEnd: entry.seqEnd,
      sourceSeqRanges: mergeSeqRanges(previous.sourceSeqRanges, entry.sourceSeqRanges),
      collapsed: Array.from(collapsedKinds),
    };
  }

  return output;
}

function mergeAssistantChunks(entries: readonly WorkingEntry[]): WorkingEntry[] {
  const output: WorkingEntry[] = [];

  for (const entry of entries) {
    const previous = output[output.length - 1];
    const shouldMerge =
      previous &&
      previous.item.type === "assistant_message" &&
      entry.item.type === "assistant_message" &&
      previous.seqEnd + 1 === entry.seqStart;

    if (!shouldMerge || !previous) {
      output.push(entry);
      continue;
    }
    const previousAssistant = previous.item as Extract<
      AgentTimelineItem,
      { type: "assistant_message" }
    >;
    const entryAssistant = entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>;

    const collapsedKinds = new Set<TimelineProjectionKind>([
      ...previous.collapsed,
      ...entry.collapsed,
      "assistant_merge",
    ]);

    output[output.length - 1] = {
      ...previous,
      item: {
        type: "assistant_message",
        text: `${previousAssistant.text}${entryAssistant.text}`,
      },
      seqEnd: entry.seqEnd,
      sourceSeqRanges: mergeSeqRanges(previous.sourceSeqRanges, entry.sourceSeqRanges),
      collapsed: Array.from(collapsedKinds),
    };
  }

  return output;
}

export function projectTimelineRows(input: {
  rows: readonly AgentTimelineRow[];
  mode: TimelineProjectionMode;
}): TimelineProjectionEntry[] {
  const canonical = makeCanonicalEntries(input.rows);
  if (input.mode === "canonical") {
    return canonical;
  }

  const toolCollapsed = collapseToolLifecycle(canonical);
  const assistantMerged = mergeAssistantChunks(toolCollapsed);
  return mergeReasoningChunks(assistantMerged);
}

/**
 * Select a timeline window based on projected-entry count, then map it back to
 * contiguous canonical rows. This avoids cutting through merged assistant
 * chunks when callers request canonical rows with a bounded limit.
 */
export function selectTimelineWindowByProjectedLimit(input: {
  rows: readonly AgentTimelineRow[];
  direction: TimelineLimitDirection;
  limit: number;
  collapseToolLifecycle?: boolean;
}): ProjectedWindowSelection {
  const { rows, direction } = input;
  const limit = Math.max(0, Math.floor(input.limit));
  const collapseTools = input.collapseToolLifecycle ?? true;
  const canonical = makeCanonicalEntries(rows);
  const projectedAll = mergeReasoningChunks(
    mergeAssistantChunks(collapseTools ? collapseToolLifecycle(canonical) : canonical),
  );

  if (projectedAll.length === 0) {
    return {
      projectedEntries: [],
      selectedRows: [],
      minSeq: null,
      maxSeq: null,
    };
  }

  let projectedEntries: typeof projectedAll;
  if (limit === 0 || limit >= projectedAll.length) {
    projectedEntries = projectedAll;
  } else if (direction === "after") {
    projectedEntries = projectedAll.slice(0, limit);
  } else {
    projectedEntries = projectedAll.slice(projectedAll.length - limit);
  }

  if (projectedEntries.length === 0) {
    return {
      projectedEntries: [],
      selectedRows: [],
      minSeq: null,
      maxSeq: null,
    };
  }

  const computeWindowBounds = (entries: readonly TimelineProjectionEntry[]) => {
    let minSeq = Number.POSITIVE_INFINITY;
    let maxSeq = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      if (entry.seqStart < minSeq) {
        minSeq = entry.seqStart;
      }
      if (entry.seqEnd > maxSeq) {
        maxSeq = entry.seqEnd;
      }
    }
    return { minSeq, maxSeq };
  };

  let { minSeq, maxSeq } = computeWindowBounds(projectedEntries);
  let expandedEntries = projectedEntries;

  if (collapseTools) {
    // Expand to include any projected entries that overlap the selected
    // canonical range. Tool lifecycle collapse can produce non-monotonic
    // seqEnd values, which would otherwise create cursor gaps.
    for (let iteration = 0; iteration < projectedAll.length + 1; iteration += 1) {
      const overlapping = projectedAll.filter(
        (entry) => entry.seqStart <= maxSeq && entry.seqEnd >= minSeq,
      );
      const nextBounds = computeWindowBounds(overlapping);
      if (
        overlapping.length === expandedEntries.length &&
        nextBounds.minSeq === minSeq &&
        nextBounds.maxSeq === maxSeq
      ) {
        expandedEntries = overlapping;
        break;
      }
      expandedEntries = overlapping;
      minSeq = nextBounds.minSeq;
      maxSeq = nextBounds.maxSeq;
    }
  }

  const selectedRows = rows.filter((row) => row.seq >= minSeq && row.seq <= maxSeq);

  return {
    projectedEntries: expandedEntries,
    selectedRows,
    minSeq: Number.isFinite(minSeq) ? minSeq : null,
    maxSeq: Number.isFinite(maxSeq) ? maxSeq : null,
  };
}

/**
 * Apply a projected-count limit to a flat AgentTimelineItem[] without seq metadata.
 * Used by callers that only have items in hand (e.g. MCP tools reading
 * `agentManager.getTimeline`). Index position is treated as canonical seq.
 */
export interface ProjectedItemSelection {
  items: AgentTimelineItem[];
  totalProjected: number;
  shownProjected: number;
}

export function selectItemsByProjectedLimit(input: {
  items: readonly AgentTimelineItem[];
  direction: TimelineLimitDirection;
  limit: number;
}): ProjectedItemSelection {
  const rows: AgentTimelineRow[] = input.items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  const projectedAll = projectTimelineRows({ rows, mode: "projected" });
  const window = selectTimelineWindowByProjectedLimit({
    rows,
    direction: input.direction,
    limit: input.limit,
  });
  return {
    items: window.selectedRows.map((row) => row.item),
    totalProjected: projectedAll.length,
    shownProjected: window.projectedEntries.length,
  };
}
