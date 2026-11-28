import { isNative, isWeb } from "./platform";

export interface PresentationCapabilities {
  /** Wide sidebar rows rename in place instead of opening a rename modal. */
  allowsInlineWorkspaceRename: boolean;
  /** Compact screens present bottom sheets (`SheetFlatList` / Gorhom modal) instead of dialogs. */
  usesCompactBottomSheet: boolean;
  /** Popover lists use tight desktop row padding instead of touch-sheet spacing. */
  usesDesktopPopoverSpacing: boolean;
}

export function resolvePresentationCapabilities(input: {
  isNative: boolean;
  isWeb: boolean;
}): PresentationCapabilities {
  return {
    allowsInlineWorkspaceRename: input.isWeb,
    usesCompactBottomSheet: input.isNative,
    usesDesktopPopoverSpacing: input.isWeb,
  };
}

const CAPABILITIES = resolvePresentationCapabilities({ isNative, isWeb });

export const allowsInlineWorkspaceRename = CAPABILITIES.allowsInlineWorkspaceRename;
export const usesCompactBottomSheet = CAPABILITIES.usesCompactBottomSheet;
export const usesDesktopPopoverSpacing = CAPABILITIES.usesDesktopPopoverSpacing;
