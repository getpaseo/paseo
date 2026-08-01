import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRowDelivery,
} from "./agent-timeline-store-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

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
): AgentTimelineFetchResult {
  const pending = timeline.rows.at(-1);
  if (
    !pending ||
    pending.seq !== timeline.window.maxSeq ||
    shouldDeliverSubmittedPromptRow(pending.delivery, pending.item, false)
  ) {
    return timeline;
  }
  const rows = timeline.rows.slice(0, -1);
  const minSeq = rows[0]?.seq ?? 0;
  const maxSeq = rows.at(-1)?.seq ?? 0;
  return {
    ...timeline,
    window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
    hasOlder: false,
    hasNewer: false,
    rows,
  };
}

export function selectSubmittedPromptTimelinePage(
  fullTimeline: AgentTimelineFetchResult,
  controlTimeline: AgentTimelineFetchResult,
  options: AgentTimelineFetchOptions,
): AgentTimelineFetchResult {
  const timeline = new InMemoryAgentTimelineStore();
  timeline.initialize("compatibility-projection", {
    epoch: fullTimeline.epoch,
    rows: fullTimeline.rows,
    nextSeq: fullTimeline.window.nextSeq,
  });
  const selected = timeline.fetch("compatibility-projection", {
    ...options,
    ...(controlTimeline.reset ? { direction: "tail", cursor: undefined } : {}),
  });
  return {
    ...selected,
    direction: controlTimeline.direction,
    reset: controlTimeline.reset,
    staleCursor: controlTimeline.staleCursor,
    gap: controlTimeline.gap,
  };
}
