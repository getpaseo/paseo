import { describe, expect, it } from "vitest";
import {
  getBottomSheetVisibleContentHeight,
  getCompactSheetSafeAreaPadding,
} from "@/components/adaptive-modal-sheet-layout";

describe("getCompactSheetSafeAreaPadding", () => {
  it("adds the bottom inset to compact sheet footers", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: false,
        hasFooter: true,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ footerPaddingBottom: 46 });
  });

  it("adds the bottom inset to compact sheet content when there is no footer", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: false,
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ contentPaddingBottom: 58 });
  });

  it("does not add a safe-area band above the compact keyboard", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
        isKeyboardVisible: true,
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
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
        baseContentPadding: 24,
        baseFooterPadding: 12,
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
