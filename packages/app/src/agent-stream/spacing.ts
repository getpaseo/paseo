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
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return 0;
  }
  if (item.kind === "user_message" && isToolSequenceItem(belowItem)) {
    return SPACING[4];
  }
  if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
    return SPACING[1];
  }
  if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
    return SPACING[1];
  }
  if (isSameAssistantBlockGroup({ item, other: belowItem })) {
    // Split markdown blocks from one assistant turn should read as continuous prose.
    return SPACING[2];
  }
  return SPACING[4];
}
