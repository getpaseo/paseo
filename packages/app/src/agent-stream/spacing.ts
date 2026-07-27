import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";

export function isSameAssistantBlockGroup(params: {
  item: StreamItem | null | undefined;
  other: StreamItem | null | undefined;
}): boolean {
  return (
    params.item?.kind === "assistant_message" &&
    params.other?.kind === "assistant_message" &&
    params.item.blockGroupId !== undefined &&
    params.item.blockGroupId === params.other.blockGroupId
  );
}

export function getAssistantBlockSpacing(params: {
  item: StreamItem;
  aboveItem: StreamItem | null | undefined;
  belowItem: StreamItem | null | undefined;
}): "default" | "compactTop" | "compactBottom" | "compactBoth" {
  if (params.item.kind !== "assistant_message") {
    return "default";
  }
  const compactTop = isSameAssistantBlockGroup({ item: params.item, other: params.aboveItem });
  const compactBottom = isSameAssistantBlockGroup({ item: params.item, other: params.belowItem });
  if (compactTop && compactBottom) return "compactBoth";
  if (compactTop) return "compactTop";
  if (compactBottom) return "compactBottom";
  return "default";
}

const isUserMessageItem = (item?: StreamItem | null) => item?.kind === "user_message";
const isToolSequenceItem = (item?: StreamItem | null) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";

// continuous / related / turn — see docs/design.md "Agent reply vertical rhythm".
// Stream gapBelow is the single owner of between-item spacing for process rows.
export const STREAM_ITEM_GAP = {
  continuous: SPACING[2],
  related: SPACING[3],
  turn: SPACING[4],
} as const;

export function getGapBetweenStreamItems(
  item: StreamItem | null,
  belowItem: StreamItem | null,
): number {
  if (!item || !belowItem) {
    return 0;
  }

  if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
    return STREAM_ITEM_GAP.continuous;
  }
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return STREAM_ITEM_GAP.continuous;
  }
  if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
    return STREAM_ITEM_GAP.turn;
  }
  // Process rows ↔ assistant prose use related so the conclusion does not glue
  // to the last tool/thinking row, without opening a full turn-sized hole.
  if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
    return STREAM_ITEM_GAP.related;
  }
  if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
    return STREAM_ITEM_GAP.related;
  }
  if (isSameAssistantBlockGroup({ item, other: belowItem })) {
    return STREAM_ITEM_GAP.continuous;
  }
  return STREAM_ITEM_GAP.turn;
}
