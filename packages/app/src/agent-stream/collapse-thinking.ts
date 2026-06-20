import type { StreamItem } from "@/types/stream";
import type { CollapseThinkingBehavior } from "@/hooks/use-settings";

export interface ThinkingGroup {
  id: string;
  anchorItemId: string;
  itemIds: string[];
  defaultExpanded: boolean;
  status: "active" | "completed";
  finalAssistantItemId: string | null;
}

export interface ThinkingGroupIndex {
  groups: ThinkingGroup[];
  groupByAnchorItemId: Map<string, ThinkingGroup>;
  groupByItemId: Map<string, ThinkingGroup>;
}

export function buildCollapseThinkingGroups(input: {
  items: readonly StreamItem[];
  behavior: Exclude<CollapseThinkingBehavior, "never">;
}): ThinkingGroupIndex {
  const { items, behavior } = input;
  const groups: ThinkingGroup[] = [];
  let turnStartIndex = findNextUserMessageIndex(items, 0);

  while (turnStartIndex !== null) {
    const turnEndIndex = findNextUserMessageIndex(items, turnStartIndex + 1) ?? items.length;
    const turnItems = items.slice(turnStartIndex + 1, turnEndIndex);
    const finalAssistantIndex = findLastAssistantMessageIndex(turnItems);
    const status = finalAssistantIndex === null ? "active" : "completed";
    const defaultExpanded = status === "active" && behavior === "completed";
    const groupItems =
      finalAssistantIndex === null
        ? turnItems
        : turnItems.filter((_, index) => index !== finalAssistantIndex);
    const finalAssistantItem =
      finalAssistantIndex === null ? null : (turnItems[finalAssistantIndex] ?? null);

    if (groupItems.length > 0) {
      const userMessage = items[turnStartIndex];
      const anchorItem = groupItems[0];
      if (userMessage && anchorItem) {
        groups.push({
          id: `thinking:${userMessage.id}:${status === "active" ? "active" : "final"}`,
          anchorItemId: anchorItem.id,
          itemIds: groupItems.map((item) => item.id),
          defaultExpanded,
          status,
          finalAssistantItemId: finalAssistantItem?.id ?? null,
        });
      }
    }

    turnStartIndex = findNextUserMessageIndex(items, turnEndIndex);
  }

  const groupByAnchorItemId = new Map<string, ThinkingGroup>();
  const groupByItemId = new Map<string, ThinkingGroup>();
  for (const group of groups) {
    groupByAnchorItemId.set(group.anchorItemId, group);
    for (const itemId of group.itemIds) {
      groupByItemId.set(itemId, group);
    }
  }

  return {
    groups,
    groupByAnchorItemId,
    groupByItemId,
  };
}

function findNextUserMessageIndex(items: readonly StreamItem[], startIndex: number): number | null {
  for (let index = startIndex; index < items.length; index += 1) {
    if (items[index]?.kind === "user_message") {
      return index;
    }
  }
  return null;
}

function findLastAssistantMessageIndex(items: readonly StreamItem[]): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "assistant_message") {
      return index;
    }
  }
  return null;
}
