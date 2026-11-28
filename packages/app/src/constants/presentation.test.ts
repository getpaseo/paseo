import { describe, expect, it } from "vitest";
import * as gpuiPresentation from "./presentation.gpui";

describe("presentation capabilities per target", () => {
  it("resolves mobile and desktop presentation answers for iOS, Android, web, and Electron", async () => {
    const basePresentation = (await import(
      new URL("./presentation.ts", import.meta.url).href
    )) as typeof import("./presentation");

    expect(
      basePresentation.resolvePresentationCapabilities({ isNative: true, isWeb: false }),
    ).toEqual({
      allowsInlineWorkspaceRename: false,
      usesCompactBottomSheet: true,
      usesDesktopPopoverSpacing: false,
      initialUiBaseFontSize: 15,
      initialContentFontSize: 16,
      usesMobileContentFontMigration: true,
      composerMinInputHeight: 30,
    });
    expect(
      basePresentation.resolvePresentationCapabilities({ isNative: false, isWeb: true }),
    ).toEqual({
      allowsInlineWorkspaceRename: true,
      usesCompactBottomSheet: false,
      usesDesktopPopoverSpacing: true,
      initialUiBaseFontSize: 14,
      initialContentFontSize: 15,
      usesMobileContentFontMigration: false,
      composerMinInputHeight: 46,
    });
  });

  it("exports plain desktop presentation values on GPUI without a target resolver", () => {
    expect({
      allowsInlineWorkspaceRename: gpuiPresentation.allowsInlineWorkspaceRename,
      usesCompactBottomSheet: gpuiPresentation.usesCompactBottomSheet,
      usesDesktopPopoverSpacing: gpuiPresentation.usesDesktopPopoverSpacing,
      initialUiBaseFontSize: gpuiPresentation.initialUiBaseFontSize,
      initialContentFontSize: gpuiPresentation.initialContentFontSize,
      usesMobileContentFontMigration: gpuiPresentation.usesMobileContentFontMigration,
      composerMinInputHeight: gpuiPresentation.composerMinInputHeight,
    }).toEqual({
      allowsInlineWorkspaceRename: true,
      usesCompactBottomSheet: false,
      usesDesktopPopoverSpacing: true,
      initialUiBaseFontSize: 14,
      initialContentFontSize: 15,
      usesMobileContentFontMigration: false,
      composerMinInputHeight: 46,
    });
    expect("resolvePresentationCapabilities" in gpuiPresentation).toBe(false);
  });
});
