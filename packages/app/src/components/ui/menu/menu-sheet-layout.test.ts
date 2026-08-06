import { describe, expect, it } from "vitest";
import { getMenuSheetBottomPadding } from "./menu-sheet-layout";

describe("getMenuSheetBottomPadding", () => {
  it("keeps breathing room below the last row when there is no system inset", () => {
    expect(
      getMenuSheetBottomPadding({
        safeAreaBottom: 0,
        breathingRoom: 4,
      }),
    ).toBe(4);
  });

  it("adds breathing room after the system navigation inset", () => {
    expect(
      getMenuSheetBottomPadding({
        safeAreaBottom: 48,
        breathingRoom: 4,
      }),
    ).toBe(52);
  });
});
