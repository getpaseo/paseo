import { FONT_SIZE } from "@/styles/theme";
import { isNative, isWeb } from "./platform";

export interface PresentationCapabilities {
  /** Wide sidebar rows rename in place instead of opening a rename modal. */
  allowsInlineWorkspaceRename: boolean;
  /** Compact screens present bottom sheets (`SheetFlatList` / Gorhom modal) instead of dialogs. */
  usesCompactBottomSheet: boolean;
  /** Popover lists use tight desktop row padding instead of touch-sheet spacing. */
  usesDesktopPopoverSpacing: boolean;
  /** Initial UI font size (pt) when no user preference is saved. */
  initialUiBaseFontSize: number;
  /** Initial chat content font size (pt) when no user preference is saved. */
  initialContentFontSize: number;
  /** Whether legacy 15 pt persisted content size migrates up to the mobile 16 pt default. */
  usesMobileContentFontMigration: boolean;
  /** Minimum multiline composer input height (pt). */
  composerMinInputHeight: number;
}

export function resolvePresentationCapabilities(input: {
  isNative: boolean;
  isWeb: boolean;
}): PresentationCapabilities {
  return {
    allowsInlineWorkspaceRename: input.isWeb,
    usesCompactBottomSheet: input.isNative,
    usesDesktopPopoverSpacing: input.isWeb,
    initialUiBaseFontSize: input.isNative ? 15 : FONT_SIZE.base,
    initialContentFontSize: input.isNative ? 16 : FONT_SIZE.content,
    usesMobileContentFontMigration: input.isNative,
    composerMinInputHeight: input.isWeb ? 46 : 30,
  };
}

const CAPABILITIES = resolvePresentationCapabilities({ isNative, isWeb });

export const allowsInlineWorkspaceRename = CAPABILITIES.allowsInlineWorkspaceRename;
export const usesCompactBottomSheet = CAPABILITIES.usesCompactBottomSheet;
export const usesDesktopPopoverSpacing = CAPABILITIES.usesDesktopPopoverSpacing;
export const initialUiBaseFontSize = CAPABILITIES.initialUiBaseFontSize;
export const initialContentFontSize = CAPABILITIES.initialContentFontSize;
export const usesMobileContentFontMigration = CAPABILITIES.usesMobileContentFontMigration;
export const composerMinInputHeight = CAPABILITIES.composerMinInputHeight;
