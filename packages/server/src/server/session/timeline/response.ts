import type { SessionOutboundMessage } from "../../messages.js";
import type { AgentTimelineFetchResult } from "../../agent/agent-timeline-store-types.js";
import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";

type TimelineResponse = Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>;

// Leave headroom under the relay's 32 MiB encrypted-frame ceiling and the socket queue limit.
const MAX_TIMELINE_RESPONSE_BYTES = 16 * 1024 * 1024;

interface TimelineResponseInput {
  requestId: string;
  agentId: string;
  agent: NonNullable<TimelineResponse["payload"]["agent"]>;
  direction: TimelineResponse["payload"]["direction"];
  limit: number;
  mergeWindow: boolean;
  fetchPage: (limit: number) => AgentTimelineFetchResult;
  supportsItem: (item: AgentTimelineItem) => boolean;
  supportsReasoningMerge: boolean;
}

class TimelinePageTooLargeError extends Error {
  constructor() {
    super("A timeline item or inseparable history group exceeds the 16 MiB history page limit");
    this.name = "TimelinePageTooLargeError";
  }
}

/** Reuse the projection pager so shrinking a response never certifies omitted lifecycle updates. */
export function createTimelineResponse(input: TimelineResponseInput): TimelineResponse {
  let limit = input.limit;
  while (true) {
    const page = input.fetchPage(limit);
    const response: TimelineResponse = {
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: input.requestId,
        agentId: input.agentId,
        agent: input.agent,
        direction: input.direction,
        projection: "projected",
        epoch: page.epoch,
        reset: page.reset,
        staleCursor: page.staleCursor,
        gap: page.gap,
        window: page.window,
        startCursor: page.startSeq === null ? null : { epoch: page.epoch, seq: page.startSeq },
        endCursor: page.endSeq === null ? null : { epoch: page.epoch, seq: page.endSeq },
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        ...(input.mergeWindow ? { mergeWindow: true } : {}),
        entries: page.rows
          .filter((entry) => input.supportsItem(entry.item))
          .map((entry) => ({
            provider: input.agent.provider,
            item: entry.item,
            timestamp: entry.timestamp,
            seqStart: entry.seqStart,
            seqEnd: entry.seqEnd,
            sourceSeqRanges: entry.sourceSeqRanges,
            turnId: entry.turnId,
            collapsed: input.supportsReasoningMerge
              ? entry.collapsed
              : entry.collapsed.filter((value) => value !== "reasoning_merge"),
          })),
        error: null,
      },
    };
    let bytes = Buffer.byteLength(
      JSON.stringify({
        ...response,
        payload: { ...response.payload, entries: [] },
      }),
    );
    let fittingEntries = 0;
    for (const [index, entry] of response.payload.entries.entries()) {
      bytes += Buffer.byteLength(JSON.stringify(entry)) + (index === 0 ? 0 : 1);
      if (bytes > MAX_TIMELINE_RESPONSE_BYTES) break;
      fittingEntries += 1;
    }
    if (bytes <= MAX_TIMELINE_RESPONSE_BYTES) return response;
    if (limit === 1 || page.rows.length === 0) throw new TimelinePageTooLargeError();
    const currentLimit = limit === 0 ? page.rows.length : Math.min(limit, page.rows.length);
    limit = Math.max(1, Math.min(fittingEntries, Math.floor(currentLimit / 2)));
  }
}
