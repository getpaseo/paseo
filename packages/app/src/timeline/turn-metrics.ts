import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import { continuesResponse } from "@/agent-stream/turn-membership";
import type { StreamItem, TimelinePosition } from "@/types/stream";

type TurnFooterAnchor = Extract<StreamItem, { kind: "assistant_message" | "tool_call" }>;

/**
 * Puts a completed turn's metrics on the row its footer hangs on: the turn's last assistant
 * message, else its last row when that row is a tool call. The daemon stamps the same row, so a
 * later timeline fetch agrees with what the live event showed.
 */
export function stampCompletedTurnMetrics(
  items: StreamItem[],
  metrics: AgentMetric[] | undefined,
  turnId: string | undefined,
): StreamItem[] {
  if (!metrics || metrics.length === 0) return items;
  const index = findTurnFooterAnchorIndex(items, turnId);
  if (index === null) return items;
  return replaceAt(items, index, metrics);
}

/**
 * Puts the metrics a timeline page carries on the rows it wrote. Every reducer path leaves a row
 * with the cursor of the last entry that wrote it, which is the entry the daemon stamped.
 */
export function stampTimelineTurnMetrics(
  items: StreamItem[],
  epoch: string,
  entries: ReadonlyArray<{ seqEnd: number; turnMetrics?: AgentMetric[] }>,
): StreamItem[] {
  const metricsBySeq = new Map<number, AgentMetric[]>();
  for (const entry of entries) {
    if (entry.turnMetrics && entry.turnMetrics.length > 0) {
      metricsBySeq.set(entry.seqEnd, entry.turnMetrics);
    }
  }
  if (metricsBySeq.size === 0) return items;

  let next = items;
  items.forEach((item, index) => {
    const metrics = isTurnFooterAnchor(item)
      ? metricsBySeq.get(cursorSeqIn(item.timelineCursor, epoch) ?? -1)
      : undefined;
    if (metrics) next = replaceAt(next, index, metrics);
  });
  return next;
}

function findTurnFooterAnchorIndex(items: StreamItem[], turnId: string | undefined): number | null {
  const last = lastIndexOfTurn(items, turnId);
  if (last === null) return null;
  for (let index = last; index >= 0; index--) {
    if (index < last && !continuesResponse(items[index], items[index + 1])) break;
    if (items[index].kind === "assistant_message") return index;
  }
  return items[last].kind === "tool_call" ? last : null;
}

function lastIndexOfTurn(items: StreamItem[], turnId: string | undefined): number | null {
  const tail = items.length - 1;
  if (tail < 0) return null;
  if (turnId === undefined) return tail;
  const index = items.findLastIndex((item) => item.turnId === turnId);
  if (index >= 0) return index;
  // Rows from daemons without turn ids belong to the trailing turn. A tail owned by another
  // turn means this turn wrote no rows.
  return items[tail].turnId === undefined ? tail : null;
}

function isTurnFooterAnchor(item: StreamItem): item is TurnFooterAnchor {
  return item.kind === "assistant_message" || item.kind === "tool_call";
}

function cursorSeqIn(cursor: TimelinePosition | undefined, epoch: string): number | null {
  return cursor?.epoch === epoch ? cursor.seq : null;
}

/** Returns `items` itself when the row already shows these metrics, so unchanged rows keep identity. */
function replaceAt(items: StreamItem[], index: number, metrics: AgentMetric[]): StreamItem[] {
  const item = items[index];
  if (!item || !isTurnFooterAnchor(item) || areMetricsEqual(item.turnMetrics, metrics)) {
    return items;
  }
  const next = [...items];
  next[index] = { ...item, turnMetrics: metrics };
  return next;
}

function areMetricsEqual(left: AgentMetric[] | undefined, right: AgentMetric[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every(
      (metric, index) =>
        metric.label === right[index].label &&
        metric.value === right[index].value &&
        metric.tone === right[index].tone,
    )
  );
}
