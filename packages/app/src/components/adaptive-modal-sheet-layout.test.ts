import { describe, expect, it } from "vitest";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";

describe("getCompactSheetSafeAreaPadding", () => {
  it("adds the bottom inset to compact sheet footers", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: true,
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
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({ contentPaddingBottom: 58 });
  });

  it("does not inset desktop sheets", () => {
    expect(
      getCompactSheetSafeAreaPadding({
        isCompact: false,
        hasFooter: false,
        baseContentPadding: 24,
        baseFooterPadding: 12,
        safeAreaBottom: 34,
      }),
    ).toEqual({});
  });
});
