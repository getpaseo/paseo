import type { StreamItem } from "@/types/stream";

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

export interface NeighborResolver {
  getNeighborItem(
    items: StreamItem[],
    index: number,
    relation: "above" | "below",
  ): StreamItem | undefined;
}

// null → auxiliary working indicator; non-null → inline footer on that block.
export function resolveInlineWorkingIndicatorItemId(
  status: string,
  liveHeadItems: StreamItem[],
  strategy: NeighborResolver,
): string | null {
  if (status !== "running") return null;
  const footerItem = liveHeadItems.find((item, index, items) => {
    if (item.kind !== "assistant_message") return false;
    return strategy.getNeighborItem(items, index, "below") === undefined;
  });
  return footerItem?.id ?? null;
}
