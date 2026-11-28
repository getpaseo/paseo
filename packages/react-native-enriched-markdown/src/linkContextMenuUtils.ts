import { normalizeLinkPatternEntries } from './linkVariantUtils';
import type { LinkContextMenuItem } from './types/MarkdownTextProps';

/**
 * Flattens `linkContextMenuItems` for native: patterns in matching order, hidden
 * items and patterns left without items dropped, callbacks kept on the JS side.
 */
export function normalizeLinkContextMenuItems(
  menus: Record<string, LinkContextMenuItem[]> | undefined
) {
  return normalizeLinkPatternEntries(
    menus,
    '[EnrichedMarkdownText] linkContextMenuItems'
  ).flatMap(([pattern, items]) => {
    const visible = items
      .filter((item) => item.visible !== false)
      .map((item) => ({
        text: item.text,
        icon: item.icon ?? '',
        disabled: item.disabled ?? false,
        destructive: item.destructive ?? false,
      }));
    return visible.length > 0 ? [{ pattern, items: visible }] : [];
  });
}

type NativeLinkContextMenuItems = ReturnType<
  typeof normalizeLinkContextMenuItems
>;

/** Whether two flattened `linkContextMenuItems` arrays describe the same menus. */
export function isLinkContextMenuItemsEqual(
  a: NativeLinkContextMenuItems,
  b: NativeLinkContextMenuItems
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return (
      entry.pattern === other.pattern &&
      entry.items.length === other.items.length &&
      entry.items.every((item, itemIndex) => {
        const otherItem = other.items[itemIndex]!;
        return (
          item.text === otherItem.text &&
          item.icon === otherItem.icon &&
          item.disabled === otherItem.disabled &&
          item.destructive === otherItem.destructive
        );
      })
    );
  });
}

/**
 * Runs the callback of the item native reported. A menu can stay open while the
 * prop changes, so the item is looked up in the current config and ignored when
 * that no longer offers it.
 */
export function dispatchLinkContextMenuItem(
  menus: Record<string, LinkContextMenuItem[]> | undefined,
  pattern: string,
  itemText: string,
  url: string
) {
  if (!menus || !Object.prototype.hasOwnProperty.call(menus, pattern)) return;
  const item = menus[pattern]?.find((candidate) => candidate.text === itemText);
  if (item && item.visible !== false && !item.disabled) item.onPress({ url });
}
