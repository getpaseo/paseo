import type { PresentationCapabilities } from "./presentation";

export function resolvePresentationCapabilities(_input: {
  isNative: boolean;
  isWeb: boolean;
}): PresentationCapabilities {
  return {
    allowsInlineWorkspaceRename: true,
    usesCompactBottomSheet: false,
    usesDesktopPopoverSpacing: true,
  };
}

export const allowsInlineWorkspaceRename = true;
export const usesCompactBottomSheet = false;
export const usesDesktopPopoverSpacing = true;
