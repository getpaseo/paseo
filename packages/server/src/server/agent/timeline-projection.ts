import { continuesTimelineTurn, isTimelineTurnTrigger } from "@getpaseo/protocol/timeline-turn";
import type { AgentTimelineItem, ToolCallDetail } from "./agent-sdk-types.js";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";

import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export type TimelineProjectionMode = "canonical" | "projected";

export interface TimelineSeqRange {
  startSeq: number;
  endSeq: number;
}

export type TimelineProjectionKind =
  | "assistant_merge"
  | "reasoning_merge"
  | "tool_lifecycle"
  | "identity";
export type TimelineLimitDirection = "tail" | "before" | "after";

export interface TimelineProjectionEntry {
  item: AgentTimelineItem;
  turnId?: string;
  providerMessageId?: string;
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

export interface ProjectedTimelinePageSelection {
  entries: TimelineProjectionEntry[];
  startSeq: number | null;
  endSeq: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
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
    next[next.length - 1] = { ...last, endSeq: Math.max(last.endSeq, seq) };
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

/** Fold a later update for the same tool call into the one it follows. */
export function mergeToolCallItems(
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
  return rows.map((row) => {
    if ("seqStart" in row) return { ...(row as ProjectedTimelineRow) };
    return {
      item: row.item,
      timestamp: row.timestamp,
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}),
      seqStart: row.seq,
      seqEnd: row.seq,
      sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }],
      collapsed: [],
    };
  });
}

function mergeIdentityMetadata(
  existing: WorkingEntry,
  entry: WorkingEntry,
  collapseKind: TimelineProjectionKind,
): Pick<WorkingEntry, "sourceSeqRanges" | "collapsed"> {
  return {
    sourceSeqRanges: mergeSeqRanges(existing.sourceSeqRanges, entry.sourceSeqRanges),
    collapsed: existing.collapsed.includes(collapseKind)
      ? existing.collapsed
      : [...existing.collapsed, collapseKind],
  };
}

function mergeIdentityEntries(existing: WorkingEntry, entry: WorkingEntry): WorkingEntry | null {
  switch (entry.item.type) {
    case "tool_call":
      if (existing.item.type !== "tool_call" || existing.turnId !== entry.turnId) return null;
      return {
        ...existing,
        item: mergeToolCallItems(existing.item, entry.item),
        timestamp: entry.timestamp,
        seqEnd: Math.max(existing.seqEnd, entry.seqEnd),
        ...mergeIdentityMetadata(existing, entry, "tool_lifecycle"),
      };
    case "plugin":
      if (existing.item.type !== "plugin") return null;
      return {
        ...entry,
        seqStart: existing.seqStart,
        ...mergeIdentityMetadata(existing, entry, "identity"),
      };
    default:
      return null;
  }
}

function collapseByIdentity(entries: readonly WorkingEntry[]): WorkingEntry[] {
  const output: WorkingEntry[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const entry of entries) {
    const identity = timelineItemIdentity(entry.item);
    if (identity === null) {
      output.push(entry);
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, output.length);
      output.push(entry);
      continue;
    }

    const existing = output[existingIndex];
    const merged = existing ? mergeIdentityEntries(existing, entry) : null;
    if (!merged) {
      indexByIdentity.set(identity, output.length);
      output.push(entry);
      continue;
    }
    output[existingIndex] = merged;
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
      previous.seqEnd + 1 === entry.seqStart &&
      previous.turnId === entry.turnId;

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
      timestamp: entry.timestamp,
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
      previous.seqEnd + 1 === entry.seqStart &&
      previous.turnId === entry.turnId;

    if (!shouldMerge || !previous) {
      output.push(entry);
      continue;
    }
    const previousAssistant = previous.item as Extract<
      AgentTimelineItem,
      { type: "assistant_message" }
    >;
    const entryAssistant = entry.item as Extract<AgentTimelineItem, { type: "assistant_message" }>;
    if (
      entryAssistant.messageId !== undefined &&
      previousAssistant.messageId !== entryAssistant.messageId
    ) {
      output.push(entry);
      continue;
    }

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
        ...(previousAssistant.messageId ? { messageId: previousAssistant.messageId } : {}),
      },
      timestamp: entry.timestamp,
      seqEnd: entry.seqEnd,
      sourceSeqRanges: mergeSeqRanges(previous.sourceSeqRanges, entry.sourceSeqRanges),
      collapsed: Array.from(collapsedKinds),
    };
  }

  return output;
}

/** A retained item. `seq` is its latest source event, not its display anchor. */
export type ProjectedTimelineRow = AgentTimelineRow & TimelineProjectionEntry;

interface ProjectedTimelinePageOptions {
  wholeTurns?: boolean;
  bounds: { minSeq: number; maxSeq: number };
  direction: TimelineLimitDirection;
  cursorSeq?: number;
  limit?: number;
}

/** Owns projected state; source events are consumed, never retained. */
export class TimelineProjection {
  private readonly rows: ProjectedTimelineRow[] = [];
  private readonly identities = new Map<string, number>();
  private lastAssistantRowIndex: number | null = null;
  // Disjoint source-coverage spans in display order. A tail starting inside a
  // span must include its first anchor to cover interleaved lifecycle updates.
  private readonly spans: { start: number; endSeq: number }[] = [];

  private readonly sourceRanges: { startSeq: number; endSeq: number; rowIndex: number }[] = [];

  constructor(rows: readonly AgentTimelineRow[] = []) {
    for (const row of rows) this.appendProjected(row);
    for (const [rowIndex, row] of this.rows.entries()) {
      for (const range of row.sourceSeqRanges) this.sourceRanges.push({ ...range, rowIndex });
    }
    this.sourceRanges.sort((a, b) => a.startSeq - b.startSeq);
  }

  append(row: AgentTimelineRow): void {
    const rowIndex = this.appendProjected(row);
    const last = this.sourceRanges.at(-1);
    if (last && last.rowIndex === rowIndex && last.endSeq + 1 === row.seq) {
      last.endSeq = row.seq;
    } else {
      this.sourceRanges.push({ startSeq: row.seq, endSeq: row.seq, rowIndex });
    }
  }

  private appendProjected(row: AgentTimelineRow): number {
    const entry = makeCanonicalEntries([row])[0];
    const identity = timelineItemIdentity(row.item);
    const index = identity === null ? undefined : this.identities.get(identity);
    const existing = index === undefined ? undefined : this.rows[index];
    const merged = existing ? mergeIdentityEntries(existing, entry) : null;
    if (merged && index !== undefined) {
      this.rows[index] = { ...merged, seq: merged.seqEnd };
      this.extendSpan(index);
      return index;
    }
    const previous = this.rows.at(-1);
    const adjacent = previous
      ? mergeReasoningChunks(mergeAssistantChunks([previous, entry]))
      : [entry];
    if (previous && adjacent.length === 1) {
      const mergedText = adjacent[0];
      this.rows[this.rows.length - 1] = { ...mergedText, seq: mergedText.seqEnd };
      this.extendSpan(this.rows.length - 1);
      return this.rows.length - 1;
    }
    if (identity !== null) this.identities.set(identity, this.rows.length);
    if (entry.item.type === "assistant_message") this.lastAssistantRowIndex = this.rows.length;
    this.rows.push({ ...entry, seq: entry.seqEnd });
    const last = this.spans.at(-1);
    if (last && last.endSeq >= entry.seqStart) {
      last.endSeq = Math.max(last.endSeq, entry.seqEnd);
    } else {
      this.spans.push({ start: this.rows.length - 1, endSeq: entry.seqEnd });
    }
    return this.rows.length - 1;
  }

  private spanIndex(rowIndex: number): number {
    let low = 0;
    let high = this.spans.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.spans[middle].start <= rowIndex) low = middle;
      else high = middle;
    }
    return low;
  }

  private extendSpan(rowIndex: number): void {
    const index = this.spanIndex(rowIndex);
    const span = this.spans[index];
    span.endSeq = Math.max(span.endSeq, this.rows[rowIndex].seqEnd);
    let end = index + 1;
    while (end < this.spans.length && this.rows[this.spans[end].start].seqStart <= span.endSeq) {
      span.endSeq = Math.max(span.endSeq, this.spans[end].endSeq);
      end++;
    }
    this.spans.splice(index + 1, end - index - 1);
  }

  getRows(): ProjectedTimelineRow[] {
    return this.rows.map((row) => ({ ...row }));
  }

  selectPage(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    if (this.rows.length === 0) {
      const cursor =
        input.cursorSeq ??
        (input.direction === "before" ? input.bounds.maxSeq + 1 : input.bounds.minSeq - 1);
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder:
          input.direction === "after"
            ? cursor >= input.bounds.minSeq
            : input.direction === "before" && cursor > input.bounds.minSeq,
        hasNewer:
          input.direction === "after"
            ? cursor < input.bounds.maxSeq
            : input.direction === "before" && cursor <= input.bounds.maxSeq,
      };
    }
    switch (input.direction) {
      case "tail":
        return this.selectTail(input);
      case "after":
        return this.selectAfter(input);
      case "before":
        return this.selectBefore(input);
    }
  }

  private selectTail(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const limit = Math.max(0, Math.floor(input.limit ?? 0));
    const requestedStart = limit === 0 ? 0 : Math.max(0, this.rows.length - limit);
    const coveredStart = this.spans[this.spanIndex(requestedStart)].start;
    const start = input.wholeTurns ? this.wholeTurnWindowStart(coveredStart) : coveredStart;
    return {
      entries: this.rows.slice(start),
      startSeq: this.rows[start].seqStart,
      endSeq: input.bounds.maxSeq,
      hasOlder: start > 0,
      hasNewer: false,
    };
  }

  private wholeTurnWindowStart(requestedStart: number): number {
    let start = requestedStart;
    for (;;) {
      while (start > 0 && continuesProjectedTurn(this.rows[start - 1], this.rows[start])) start--;
      // Source coverage can pull in an earlier tool and therefore its entire run.
      const coveredStart = this.spans[this.spanIndex(start)].start;
      if (coveredStart === start) return start;
      start = coveredStart;
    }
  }

  private selectAfter(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const startSeq = Math.max(
      input.bounds.minSeq,
      (input.cursorSeq ?? input.bounds.minSeq - 1) + 1,
    );
    let low = 0;
    let high = this.sourceRanges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sourceRanges[middle].endSeq < startSeq) low = middle + 1;
      else high = middle;
    }
    const indexes = new Set<number>();
    const limit = Math.max(0, Math.floor(input.limit ?? 0));
    for (let i = low; i < this.sourceRanges.length; i++) {
      const range = this.sourceRanges[i];
      if (range.startSeq > input.bounds.maxSeq) break;
      indexes.add(range.rowIndex);
      if (limit > 0 && indexes.size === limit) break;
    }
    const entries = [...indexes].sort((a, b) => a - b).map((index) => this.rows[index]);
    const selected = selectProjectedEntriesAfter({
      entries,
      startSeq,
      maxSeq: input.bounds.maxSeq,
      limit,
    });
    return {
      entries: selected.entries,
      startSeq: selected.endSeq === null ? null : startSeq,
      endSeq: selected.endSeq,
      hasOlder: startSeq > input.bounds.minSeq,
      hasNewer: selected.endSeq !== null && selected.endSeq < input.bounds.maxSeq,
    };
  }

  private selectBefore(input: ProjectedTimelinePageOptions): ProjectedTimelinePageSelection {
    const endSeq = Math.min(input.bounds.maxSeq, (input.cursorSeq ?? input.bounds.maxSeq + 1) - 1);
    if (endSeq >= input.bounds.minSeq) {
      let low = 0;
      let high = this.rows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.rows[middle].seqStart <= endSeq) low = middle + 1;
        else high = middle;
      }
      const limit = Math.max(0, Math.floor(input.limit ?? 0));
      const requestedStart = limit === 0 ? 0 : Math.max(0, low - limit);
      const start = input.wholeTurns ? this.wholeTurnWindowStart(requestedStart) : requestedStart;
      // Choose the window before extending the right edge, so a prompt jump
      // cannot lose its target when the next turn is arbitrarily large.
      if (input.wholeTurns) {
        while (low < this.rows.length && continuesProjectedTurn(this.rows[low - 1], this.rows[low]))
          low++;
      }
      let selectedEnd = endSeq;
      if (input.wholeTurns)
        selectedEnd = low === this.rows.length ? input.bounds.maxSeq : this.rows[low].seqStart - 1;
      return {
        entries: this.rows.slice(start, low),
        startSeq: this.rows[start]?.seqStart ?? null,
        endSeq: selectedEnd,
        hasOlder: start > 0,
        hasNewer: selectedEnd < input.bounds.maxSeq,
      };
    }
    return { entries: [], startSeq: null, endSeq: null, hasOlder: false, hasNewer: true };
  }

  getLastItem(seq: number): AgentTimelineItem | null {
    const last = this.sourceRanges.at(-1);
    return last?.endSeq === seq ? this.rows[last.rowIndex].item : null;
  }

  getLastAssistantMessage(): string | null {
    const row = this.lastAssistantRowIndex === null ? null : this.rows[this.lastAssistantRowIndex];
    return row?.item.type === "assistant_message" ? row.item.text : null;
  }

  enrichSubmittedUserMessage(
    clientMessageId: string,
    providerMessageId: string,
  ): ProjectedTimelineRow | null {
    const index = this.rows.findIndex(
      (row) => row.item.type === "user_message" && row.item.clientMessageId === clientMessageId,
    );
    if (index < 0) return null;
    this.rows[index] = { ...this.rows[index], providerMessageId };
    return { ...this.rows[index] };
  }
}

export function projectTimelineRows(input: {
  rows: readonly AgentTimelineRow[];
  mode: TimelineProjectionMode;
}): TimelineProjectionEntry[] {
  const canonical = makeCanonicalEntries(input.rows);
  if (input.mode === "canonical") {
    return canonical;
  }

  const toolCollapsed = collapseByIdentity(canonical);
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
}): ProjectedWindowSelection {
  const { rows, direction } = input;
  const limit = Math.max(0, Math.floor(input.limit));
  const canonical = makeCanonicalEntries(rows);
  const projectedAll = mergeReasoningChunks(mergeAssistantChunks(collapseByIdentity(canonical)));

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

  // Expand to include any projected entries that overlap the selected canonical
  // range. Tool lifecycle collapse can produce non-monotonic seqEnd values,
  // which would otherwise create cursor gaps.
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

  const selectedRows = rows.filter((row) => row.seq >= minSeq && row.seq <= maxSeq);

  return {
    projectedEntries: expandedEntries,
    selectedRows,
    minSeq: Number.isFinite(minSeq) ? minSeq : null,
    maxSeq: Number.isFinite(maxSeq) ? maxSeq : null,
  };
}

function firstSourceSeqInRange(
  entry: TimelineProjectionEntry,
  startSeq: number,
  endSeq: number,
): number | null {
  for (const range of entry.sourceSeqRanges) {
    const firstSeq = Math.max(range.startSeq, startSeq);
    if (firstSeq <= Math.min(range.endSeq, endSeq)) return firstSeq;
  }
  return null;
}

interface ProjectedEntryCandidate {
  entry: TimelineProjectionEntry;
  index: number;
  firstSourceSeq: number;
}

function selectProjectedEntriesAfter(input: {
  entries: readonly TimelineProjectionEntry[];
  startSeq: number;
  maxSeq: number;
  limit: number;
}): { entries: TimelineProjectionEntry[]; endSeq: number | null } {
  const eligible = input.entries
    .map((entry, index) => ({
      entry,
      index,
      firstSourceSeq: firstSourceSeqInRange(entry, input.startSeq, input.maxSeq),
    }))
    .filter((candidate): candidate is ProjectedEntryCandidate => candidate.firstSourceSeq !== null)
    .sort((left, right) => left.firstSourceSeq - right.firstSourceSeq || left.index - right.index);
  const selected = input.limit === 0 ? eligible : eligible.slice(0, input.limit);
  const selectedEntries = selected
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.entry);
  if (selectedEntries.length === 0) return { entries: [], endSeq: null };

  const selectedRanges = selectedEntries
    .flatMap((entry) => entry.sourceSeqRanges)
    .sort((left, right) => left.startSeq - right.startSeq || left.endSeq - right.endSeq);
  // Wide projected entries can include future, discontiguous source ranges. The
  // page cursor advances only through source rows covered without a gap.
  let endSeq = input.startSeq - 1;
  for (const range of selectedRanges) {
    if (range.endSeq <= endSeq) continue;
    if (range.startSeq > endSeq + 1) break;
    endSeq = Math.min(range.endSeq, input.maxSeq);
  }

  return {
    entries: selectedEntries,
    endSeq: endSeq >= input.startSeq ? endSeq : null,
  };
}

function continuesProjectedTurn(
  previous: TimelineProjectionEntry,
  next: TimelineProjectionEntry,
): boolean {
  return continuesTimelineTurn(previous.turnId, next.turnId, isTimelineTurnTrigger(next.item));
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
