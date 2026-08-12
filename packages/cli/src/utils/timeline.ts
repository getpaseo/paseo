import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const LIVE_HISTORY_FETCH_TIMEOUT_MS = 2_000;
const MAX_TAIL_TIMELINE_PAGE_REQUESTS = 4;

export interface TimelineFetchOptions {
  direction: "tail" | "before";
  cursor?: { epoch: string; seq: number };
  limit: number;
  projection: "projected";
  timeout?: number;
}

export interface TimelineFetchResponse {
  entries: Array<{ item: AgentTimelineItem }>;
  startCursor: { epoch: string; seq: number } | null;
  hasOlder: boolean;
}

export interface TimelineFetchClient {
  fetchAgentTimeline(
    agentId: string,
    options: TimelineFetchOptions,
  ): Promise<TimelineFetchResponse>;
}

interface FetchProjectedTimelineItemsInput {
  client: TimelineFetchClient;
  agentId: string;
  tailCount?: number;
  matches?: (item: AgentTimelineItem) => boolean;
  timeoutMs?: number;
}

export async function fetchProjectedTimelineItems(
  input: FetchProjectedTimelineItemsInput,
): Promise<AgentTimelineItem[]> {
  const tailCount = input.tailCount;
  if (tailCount === undefined) {
    const timeline = await input.client.fetchAgentTimeline(input.agentId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
      timeout: input.timeoutMs,
    });
    const items = timeline.entries.map((entry) => entry.item);
    return input.matches ? items.filter(input.matches) : items;
  }
  if (tailCount === 0) {
    return [];
  }

  let page = await input.client.fetchAgentTimeline(input.agentId, {
    direction: "tail",
    limit: tailCount,
    projection: "projected",
    timeout: input.timeoutMs,
  });
  const pages = [page.entries.map((entry) => entry.item)];
  for (
    let requestCount = 1;
    page.hasOlder &&
    page.startCursor !== null &&
    requestCount < MAX_TAIL_TIMELINE_PAGE_REQUESTS &&
    hasTooFewMatchingItems(pages.flat(), input);
    requestCount += 1
  ) {
    page = await input.client.fetchAgentTimeline(input.agentId, {
      direction: "before",
      cursor: page.startCursor,
      limit: tailCount,
      projection: "projected",
      timeout: input.timeoutMs,
    });
    pages.unshift(page.entries.map((entry) => entry.item));
  }

  const items = pages.flat();
  const matchingItems = input.matches ? items.filter(input.matches) : items;
  return matchingItems.slice(-tailCount);
}

function hasTooFewMatchingItems(
  items: readonly AgentTimelineItem[],
  input: FetchProjectedTimelineItemsInput,
): boolean {
  const targetCount = input.tailCount ?? 0;
  const matchingCount = input.matches ? items.filter(input.matches).length : items.length;
  return matchingCount < targetCount;
}
