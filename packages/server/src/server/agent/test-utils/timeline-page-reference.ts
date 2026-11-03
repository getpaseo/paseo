// Frozen pre-index page selection: differential oracle for retained projection tests.
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import {
  TimelineProjection,
  projectTimelineRows,
  type TimelineProjectionEntry,
  type ProjectedTimelineRow,
  type TimelineLimitDirection,
  type ProjectedTimelinePageSelection,
} from "../timeline-projection.js";

function makeCanonicalEntries(rows: readonly AgentTimelineRow[]): TimelineProjectionEntry[] {
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

function getTimelineBounds(
  rows: readonly AgentTimelineRow[],
): { minSeq: number; maxSeq: number } | null {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) {
    return null;
  }
  const entries = makeCanonicalEntries(rows);
  return {
    minSeq: entries.reduce((min, e) => Math.min(min, e.seqStart), Infinity),
    maxSeq: entries.reduce((max, e) => Math.max(max, e.seqEnd), 0),
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

function selectProjectedEntriesBefore(input: {
  entries: readonly TimelineProjectionEntry[];
  endSeq: number;
  limit: number;
}): { entries: TimelineProjectionEntry[]; startSeq: number | null; hasOlder: boolean } {
  // Older history follows projected display order. Lifecycle updates can move an
  // entry's seqEnd without moving its display anchor, so seqStart keeps the full
  // projected item on exactly one backward page.
  const eligible = input.entries.filter((entry) => entry.seqStart <= input.endSeq);
  const selected =
    input.limit === 0 || input.limit >= eligible.length
      ? eligible
      : eligible.slice(eligible.length - input.limit);

  return {
    entries: selected,
    startSeq: selected[0]?.seqStart ?? null,
    hasOlder: selected.length < eligible.length,
  };
}

function selectProjectedEntriesTail(
  projectedAll: TimelineProjectionEntry[],
  limit: number,
  bounds: { minSeq: number; maxSeq: number },
): ProjectedTimelinePageSelection {
  let start = limit === 0 ? 0 : Math.max(0, projectedAll.length - limit);
  // Include earlier display anchors with updates in the selected source window,
  // so a tail certifies contiguous coverage even with interleaved tool updates.
  for (let i = start - 1; i >= 0; i--) {
    if (projectedAll[i].seqEnd >= projectedAll[start].seqStart) start = i;
  }
  const selected = projectedAll.slice(start);
  return {
    entries: selected,
    startSeq: selected[0]?.seqStart ?? null,
    endSeq: bounds.maxSeq,
    hasOlder: start > 0,
    hasNewer: false,
  };
}

export function selectReferenceProjectedTimelinePage(input: {
  rows: readonly AgentTimelineRow[];
  bounds?: { minSeq: number; maxSeq: number };
  direction: TimelineLimitDirection;
  cursorSeq?: number;
  limit?: number;
}): ProjectedTimelinePageSelection {
  const limit = input.limit === undefined ? 0 : Math.max(0, Math.floor(input.limit));
  const bounds = input.bounds ?? getTimelineBounds(input.rows);
  const projectedAll = projectTimelineRows({ rows: input.rows, mode: "projected" });
  if (!bounds) {
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: false,
      hasNewer: false,
    };
  }

  if (projectedAll.length === 0) {
    if (input.direction === "after") {
      const cursorSeq = input.cursorSeq ?? bounds.minSeq - 1;
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder: cursorSeq >= bounds.minSeq,
        hasNewer: cursorSeq < bounds.maxSeq,
      };
    }
    if (input.direction === "before") {
      const cursorSeq = input.cursorSeq ?? bounds.maxSeq + 1;
      return {
        entries: [],
        startSeq: null,
        endSeq: null,
        hasOlder: cursorSeq > bounds.minSeq,
        hasNewer: cursorSeq <= bounds.maxSeq,
      };
    }
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: false,
      hasNewer: false,
    };
  }

  if (input.direction === "tail") {
    return selectProjectedEntriesTail(projectedAll, limit, bounds);
  }

  if (input.direction === "after") {
    const cursorSeq = input.cursorSeq ?? bounds.minSeq - 1;
    const startSeq = Math.max(bounds.minSeq, cursorSeq + 1);
    const selected = selectProjectedEntriesAfter({
      entries: projectedAll,
      startSeq,
      maxSeq: bounds.maxSeq,
      limit,
    });
    return {
      entries: selected.entries,
      startSeq: selected.endSeq === null ? null : startSeq,
      endSeq: selected.endSeq,
      hasOlder: startSeq > bounds.minSeq,
      hasNewer: selected.endSeq !== null && selected.endSeq < bounds.maxSeq,
    };
  }

  const cursorSeq = input.cursorSeq ?? bounds.maxSeq + 1;
  const endSeq = Math.min(bounds.maxSeq, cursorSeq - 1);
  if (endSeq < bounds.minSeq) {
    return {
      entries: [],
      startSeq: null,
      endSeq: null,
      hasOlder: false,
      hasNewer: endSeq < bounds.maxSeq,
    };
  }

  const selected = selectProjectedEntriesBefore({ entries: projectedAll, endSeq, limit });
  return {
    entries: selected.entries,
    startSeq: selected.startSeq,
    endSeq,
    hasOlder: selected.hasOlder,
    hasNewer: endSeq < bounds.maxSeq,
  };
}

// Existing selection fixtures exercise the retained owner through its public API.
export function selectProjectedTimelinePage(
  input: Parameters<typeof selectReferenceProjectedTimelinePage>[0] & { wholeTurns?: boolean },
) {
  const projection = new TimelineProjection(input.rows);
  const bounds = input.bounds ?? getTimelineBounds(input.rows) ?? { minSeq: 0, maxSeq: 0 };
  const page = projection.selectPage({ ...input, bounds });
  return {
    ...page,
    entries: page.entries.map((row) => {
      const { seq: _seq, ...entry } = row as ProjectedTimelineRow;
      return entry;
    }),
  };
}
