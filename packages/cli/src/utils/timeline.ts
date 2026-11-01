import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const LIVE_HISTORY_FETCH_TIMEOUT_MS = 2_000;

interface FetchProjectedTimelineItemsInput {
  client: DaemonClient;
  agentId: string;
  timeoutMs?: number;
  sinceTimestampMs?: number;
}

export async function fetchProjectedTimelineItems(
  input: FetchProjectedTimelineItemsInput,
): Promise<AgentTimelineItem[]> {
  const timeline = await input.client.fetchAgentTimeline(input.agentId, {
    direction: "tail",
    limit: 0,
    projection: "projected",
    timeout: input.timeoutMs,
  });
  const pages = [timeline.entries];
  let page = timeline;
  while (page.hasOlder && page.startCursor) {
    const older = await input.client.fetchAgentTimeline(input.agentId, {
      direction: "before",
      cursor: page.startCursor,
      limit: 40,
      projection: "projected",
      timeout: input.timeoutMs,
    });
    if (older.reset || older.epoch !== timeline.epoch) {
      throw new Error("Timeline changed while reading history; retry the request");
    }
    if (!older.startCursor || older.startCursor.seq >= page.startCursor.seq) {
      throw new Error("Timeline pagination did not advance");
    }
    pages.push(older.entries);
    page = older;
  }
  let entries = pages.toReversed().flat();
  const sinceTimestampMs = input.sinceTimestampMs;
  if (sinceTimestampMs !== undefined) {
    entries = entries.filter((entry) => Date.parse(entry.timestamp) >= sinceTimestampMs);
  }
  return entries.map((entry) => entry.item);
}
