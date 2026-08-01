import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineRowDelivery,
} from "./agent-timeline-store-types.js";

export const AWAITING_PROVIDER_IDENTITY_DELIVERY = "awaiting_provider_identity" as const;

export function shouldDeliverSubmittedPromptRow(input: {
  delivery: AgentTimelineRowDelivery | undefined;
  item: AgentTimelineItem;
  supportsRevisions: boolean;
}): boolean {
  return (
    input.supportsRevisions ||
    input.delivery !== AWAITING_PROVIDER_IDENTITY_DELIVERY ||
    input.item.type !== "user_message" ||
    input.item.messageId !== undefined
  );
}

export function findSubmittedPromptVisibleMaxSeq(
  rows: readonly AgentTimelineRow[],
  maxSeq: number,
): number {
  let visibleMaxSeq = maxSeq;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      !row ||
      row.seq !== visibleMaxSeq ||
      shouldDeliverSubmittedPromptRow({
        delivery: row.delivery,
        item: row.item,
        supportsRevisions: false,
      })
    ) {
      break;
    }
    visibleMaxSeq -= 1;
  }
  return visibleMaxSeq;
}

export function projectSubmittedPromptTimeline(input: {
  timeline: AgentTimelineFetchResult;
  visibleMaxSeq: number;
  cursorSeq?: number;
}): AgentTimelineFetchResult {
  const rows = input.timeline.rows.filter((row) => row.seq <= input.visibleMaxSeq);
  const selectedEndSeq = rows.at(-1)?.seq ?? input.cursorSeq ?? 0;
  return {
    ...input.timeline,
    window: {
      ...input.timeline.window,
      maxSeq: input.visibleMaxSeq,
      nextSeq: input.visibleMaxSeq + 1,
    },
    hasNewer: input.timeline.hasNewer && selectedEndSeq < input.visibleMaxSeq,
    rows,
  };
}
