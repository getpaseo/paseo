import { describe, expect, it } from "vitest";
import {
  getBottomSheetVisibleContentHeight,
  getCompactSheetSafeAreaPadding,
} from "@/components/adaptive-modal-sheet-layout";

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

describe("getBottomSheetVisibleContentHeight", () => {
  it("stops subtracting the retained keyboard height after the keyboard hides", () => {
    const layout = {
      containerHeight: 874,
      contentPosition: 88,
      handleHeight: 24,
      keyboardHeight: 344,
    };

    expect(getBottomSheetVisibleContentHeight({ ...layout, isKeyboardVisible: true })).toBe(418);
    expect(getBottomSheetVisibleContentHeight({ ...layout, isKeyboardVisible: false })).toBe(762);
  });
});
