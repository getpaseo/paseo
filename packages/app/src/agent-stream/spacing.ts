import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";

export function getAssistantMessageSpacing(params: {
  item: StreamItem;
  hasFooterBelow?: boolean;
}): "default" | "compactBottom" {
  return params.item.kind === "assistant_message" && params.hasFooterBelow
    ? "compactBottom"
    : "default";
}

/** A prompt sits this far above whatever answers it: a tool row, its turn's summary line or the reply. */
const GAP_BELOW_PROMPT = SPACING[4];

const isUserMessageItem = (item?: StreamItem | null) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem | null) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";

export function getGapBetweenStreamItems(
  item: StreamItem | null,
  belowItem: StreamItem | null,
): number {
  if (!item || !belowItem) {
    return 0;
  }

  if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
    return SPACING[1];
  }
  if (isUserMessageItem(item)) {
    return GAP_BELOW_PROMPT;
  }
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return 0;
  }
  if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
    return SPACING[1];
  }
  if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
    return SPACING[1];
  }
  return SPACING[4];
}

/**
 * A collapsed turn's summary line stands in for the turn's rows, so it sits below the row that
 * hosts it as the turn's first row would: apart from a prompt, flush under a tool row.
 */
export function getGapAboveTurnSummary(host: StreamItem): number {
  return isUserMessageItem(host) ? GAP_BELOW_PROMPT : 0;
}
