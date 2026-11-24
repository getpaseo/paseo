import type { LinkContextMenuItem } from './types/MarkdownTextProps';
/**
 * Flattens `linkContextMenuItems` for native: patterns in matching order, hidden
 * items and patterns left without items dropped, callbacks kept on the JS side.
 */
export declare function normalizeLinkContextMenuItems(menus: Record<string, LinkContextMenuItem[]> | undefined): {
    pattern: string;
    items: {
        text: string;
        icon: string;
        disabled: boolean;
        destructive: boolean;
    }[];
}[];
type NativeLinkContextMenuItems = ReturnType<typeof normalizeLinkContextMenuItems>;
/** Whether two flattened `linkContextMenuItems` arrays describe the same menus. */
export declare function isLinkContextMenuItemsEqual(a: NativeLinkContextMenuItems, b: NativeLinkContextMenuItems): boolean;
/**
 * Runs the callback of the item native reported. A menu can stay open while the
 * prop changes, so the item is looked up in the current config and ignored when
 * that no longer offers it.
 */
export declare function dispatchLinkContextMenuItem(menus: Record<string, LinkContextMenuItem[]> | undefined, pattern: string, itemText: string, url: string): void;
export {};
//# sourceMappingURL=linkContextMenuUtils.d.ts.map