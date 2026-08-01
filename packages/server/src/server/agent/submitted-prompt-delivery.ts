import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchResult,
  AgentTimelineRowDelivery,
} from "./agent-timeline-store-types.js";

export const AWAITING_PROVIDER_IDENTITY_DELIVERY = "awaiting_provider_identity" as const;

export function shouldDeliverSubmittedPromptRow(
  delivery: AgentTimelineRowDelivery | undefined,
  item: AgentTimelineItem,
  supportsRevisions: boolean,
): boolean {
  return (
    supportsRevisions ||
    delivery !== AWAITING_PROVIDER_IDENTITY_DELIVERY ||
    item.type !== "user_message" ||
    item.messageId !== undefined
  );
}

export function projectSubmittedPromptTimeline(
  timeline: AgentTimelineFetchResult,
  fullTimeline = timeline,
  cursorSeq = 0,
): AgentTimelineFetchResult {
  const pending = fullTimeline.rows.at(-1);
  if (
    !pending ||
    pending.seq !== fullTimeline.window.maxSeq ||
    shouldDeliverSubmittedPromptRow(pending.delivery, pending.item, false)
  ) {
    return timeline;
  }
  const visibleMaxSeq = pending.seq - 1;
  const rows = timeline.rows.filter((row) => row.seq <= visibleMaxSeq);
  const selectedEndSeq = rows.at(-1)?.seq ?? cursorSeq;
  return {
    ...timeline,
    window: {
      ...timeline.window,
      minSeq:
        visibleMaxSeq === 0 || timeline.window.minSeq > visibleMaxSeq ? 0 : timeline.window.minSeq,
      maxSeq: visibleMaxSeq,
      nextSeq: visibleMaxSeq + 1,
    },
    hasNewer: timeline.hasNewer && selectedEndSeq < visibleMaxSeq,
    rows,
  };
}
