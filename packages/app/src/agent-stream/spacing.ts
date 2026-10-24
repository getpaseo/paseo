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

const isUserMessageItem = (item?: StreamItem | null) => item?.kind === "user_message";

// Plugin items projected from a tool call, thought, or todo list take part in the tool
// sequence, so a plugin that renders those items keeps the native stacking and spacing.
export function isToolSequenceItem(item?: StreamItem | null): boolean {
  const kind = item?.kind === "plugin" ? item.sourceKind : item?.kind;
  return kind === "tool_call" || kind === "thought" || kind === "todo_list";
}

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
  if (item.kind === "user_message" && belowItem.kind === "assistant_message") {
    return 0;
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
  return SPACING[4];
}
