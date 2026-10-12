import { describe, expect, it } from "vitest";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";

describe("getCompactSheetSafeAreaPadding", () => {
  it("assigns safe clearance to the footer independently of decorative padding", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: false,
        hasFooter: true,
        safeAreaBottom: 34,
      }),
    ).toEqual({ footerPaddingBottom: 34 });
  });

  it("assigns safe clearance to the body only without a footer", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: false,
        hasFooter: false,
        safeAreaBottom: 34,
      }),
    ).toEqual({ contentPaddingBottom: 34 });
  });

  it("does not add a safe-area band above the compact keyboard", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: true,
        hasFooter: false,
        safeAreaBottom: 34,
      }),
    ).toEqual({});
  });

  it("does not inset desktop sheets", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: false,
        isKeyboardVisible: false,
        hasFooter: false,
        safeAreaBottom: 34,
      }),
    ).toEqual({});
  });
});
