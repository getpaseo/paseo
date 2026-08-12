import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const LIVE_HISTORY_FETCH_TIMEOUT_MS = 2_000;
const MAX_UNFILTERED_TAIL_TIMELINE_PAGE_REQUESTS = 4;

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
  const matchingPages: AgentTimelineItem[][] = [];
  let matchingItemCount = 0;
  function collectMatchingItems(entries: TimelineFetchResponse["entries"]): void {
    const items = entries.map((entry) => entry.item);
    const matchingItems = input.matches ? items.filter(input.matches) : items;
    if (matchingItems.length > 0) {
      matchingPages.push(matchingItems);
    }
    matchingItemCount += matchingItems.length;
  }
  collectMatchingItems(page.entries);

  // A filtered tail must find the requested number of matches or reach history start. An
  // unfiltered tail normally fills in one response, so retain its defensive page cap.
  const maxPageRequests = input.matches
    ? Number.POSITIVE_INFINITY
    : MAX_UNFILTERED_TAIL_TIMELINE_PAGE_REQUESTS;
  for (
    let requestCount = 1;
    page.hasOlder &&
    page.startCursor !== null &&
    requestCount < maxPageRequests &&
    matchingItemCount < tailCount;
    requestCount += 1
  ) {
    page = await input.client.fetchAgentTimeline(input.agentId, {
      direction: "before",
      cursor: page.startCursor,
      limit: tailCount,
      projection: "projected",
      timeout: input.timeoutMs,
    });
    collectMatchingItems(page.entries);
  }

  return matchingPages.toReversed().flat().slice(-tailCount);
}
