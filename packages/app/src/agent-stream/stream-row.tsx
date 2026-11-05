import { memo, type ReactNode, type RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import { DisclosureRow } from "./disclosure";
import type { StreamLayoutItem } from "./layout";
import type { StreamViewportHandle } from "./strategy";

/**
 * Renders a timeline row from the item the row was handed. The item is a revision of
 * `layoutItem.item` with the same content: render from it, so a revision that leaves the layout
 * unchanged still renders the row again.
 */
export type RenderStreamItem = (item: StreamItem, layoutItem: StreamLayoutItem) => ReactNode;

// Live and retained rows use the same boundary so completion preserves the message
// subtree, including measured diagrams and selections. LegendList renders every mounted row
// again when `extraData` (the history renderer) changes, and history rows shift index when older
// history loads. This boundary limits that pass: a row renders again only when its stream item
// identity, its layout item identity, or the renderer itself changes. Item identity is the
// revision signal the strategy already uses (`useRevisedHistoryRows` clones items whose content or
// display state changed). The row passes the item to the renderer, so the React Compiler's cache
// of the rendered content keys on it too.
const StreamRow = memo(function StreamRow({
  item,
  layoutItem,
  renderStreamItem,
  viewportRef,
}: {
  item: StreamItem;
  layoutItem: StreamLayoutItem;
  renderStreamItem: RenderStreamItem;
  viewportRef: RefObject<StreamViewportHandle | null>;
}) {
  return (
    <DisclosureRow rowId={item.id} viewportRef={viewportRef}>
      {renderStreamItem(item, layoutItem)}
    </DisclosureRow>
  );
});

export function renderStreamRow(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: RenderStreamItem;
  viewportRef: RefObject<StreamViewportHandle | null>;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return (
    <StreamRow
      item={input.item}
      layoutItem={layoutItem}
      renderStreamItem={input.renderStreamItem}
      viewportRef={input.viewportRef}
    />
  );
}
