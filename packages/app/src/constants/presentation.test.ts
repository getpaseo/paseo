import { describe, expect, it } from "vitest";
import * as gpuiPresentation from "./presentation.gpui";

describe("presentation capabilities per target", () => {
  it("gives desktop presentation capabilities on GPUI, web, and Electron, and touch sheet/modal defaults on iOS/Android", async () => {
    const basePresentation = (await import(
      new URL("./presentation.ts", import.meta.url).href
    )) as typeof gpuiPresentation;

    expect(
      basePresentation.resolvePresentationCapabilities({ isNative: true, isWeb: false }),
    ).toEqual({
      allowsInlineWorkspaceRename: false,
      usesCompactBottomSheet: true,
      usesDesktopPopoverSpacing: false,
    });
    expect(
      basePresentation.resolvePresentationCapabilities({ isNative: false, isWeb: true }),
    ).toEqual({
      allowsInlineWorkspaceRename: true,
      usesCompactBottomSheet: false,
      usesDesktopPopoverSpacing: true,
    });
    expect({
      allowsInlineWorkspaceRename: gpuiPresentation.allowsInlineWorkspaceRename,
      usesCompactBottomSheet: gpuiPresentation.usesCompactBottomSheet,
      usesDesktopPopoverSpacing: gpuiPresentation.usesDesktopPopoverSpacing,
    }).toEqual({
      allowsInlineWorkspaceRename: true,
      usesCompactBottomSheet: false,
      usesDesktopPopoverSpacing: true,
    });
  });
});
