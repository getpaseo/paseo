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
  hasFooterBelow?: boolean;
}): "default" | "compactTop" | "compactBottom" | "compactBoth" {
  if (params.item.kind !== "assistant_message") {
    return "default";
  }
  const compactTop = isSameAssistantBlockGroup({ item: params.item, other: params.aboveItem });
  const compactBottom =
    params.hasFooterBelow ||
    isSameAssistantBlockGroup({ item: params.item, other: params.belowItem });
  if (compactTop && compactBottom) return "compactBoth";
  if (compactTop) return "compactTop";
  if (compactBottom) return "compactBottom";
  return "default";
}

// A plugin row that a timeline transformer put in place of an item is spaced like that item, so
// a plugin that redraws tool calls or thoughts keeps them as tight as Paseo's own.
const spacingKind = (item?: StreamItem | null) =>
  item?.kind === "plugin" ? item.sourceKind : item?.kind;
const isUserMessageItem = (item?: StreamItem | null) => spacingKind(item) === "user_message";
const isAssistantMessageItem = (item?: StreamItem | null) =>
  spacingKind(item) === "assistant_message";
const isToolSequenceItem = (item?: StreamItem | null) => {
  const kind = spacingKind(item);
  return kind === "tool_call" || kind === "thought" || kind === "todo_list";
};

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
  if (isUserMessageItem(item) && isAssistantMessageItem(belowItem)) {
    return 0;
  }
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return 0;
  }
  if (isUserMessageItem(item) && isToolSequenceItem(belowItem)) {
    return SPACING[4];
  }
  if (isAssistantMessageItem(item) && isToolSequenceItem(belowItem)) {
    return SPACING[1];
  }
  if (isToolSequenceItem(item) && isAssistantMessageItem(belowItem)) {
    return SPACING[1];
  }
  if (isSameAssistantBlockGroup({ item, other: belowItem })) {
    return SPACING[3];
  }
  return SPACING[4];
}
