import type { AgentTimelineRow } from "../../agent-timeline-store-types.js";
import type { TimelineEntry } from "./backend.js";

/** The source row an entry commits as, at `seq`. */
export function buildSourceRow(
  entry: TimelineEntry,
  seq: number,
  timestamp: string,
): AgentTimelineRow {
  return {
    seq,
    timestamp: entry.timestamp ?? timestamp,
    item: entry.item,
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    ...(entry.providerMessageId ? { providerMessageId: entry.providerMessageId } : {}),
    ...(entry.providerPromptText !== undefined
      ? { providerPromptText: entry.providerPromptText }
      : {}),
    ...(entry.rejected ? { rejected: true } : {}),
    ...(entry.turnMetrics ? { turnMetrics: entry.turnMetrics } : {}),
  };
}
