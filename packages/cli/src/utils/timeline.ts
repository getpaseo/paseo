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
  let entries = timeline.entries;
  const sinceTimestampMs = input.sinceTimestampMs;
  if (sinceTimestampMs !== undefined) {
    entries = entries.filter((entry) => Date.parse(entry.timestamp) >= sinceTimestampMs);
  }
  return entries.map((entry) => entry.item);
}
