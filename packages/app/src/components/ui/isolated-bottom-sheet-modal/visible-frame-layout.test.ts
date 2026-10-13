import { describe, expect, it } from "vitest";
import { getBottomSheetVisibleContentHeight } from "./visible-frame-layout";

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

// Below the lowest snap the frame must travel with the sheet, not shrink to the screen edge.
describe("sheet footer motion", () => {
  it("keeps the frame height fixed while opening and panning below the lowest snap", () => {
    const layout = {
      containerHeight: 1000,
      handleHeight: 24,
      keyboardHeight: 0,
      isKeyboardVisible: false,
      lowestDetentPosition: 400,
    };
    const heights = [1000, 800, 600, 400].map((contentPosition) =>
      getBottomSheetVisibleContentHeight({ ...layout, contentPosition }),
    );
    expect(heights).toEqual([576, 576, 576, 576]);
  });
});

it("resizes above the lowest snap and never returns negative or unmeasured heights", () => {
  const layout = {
    containerHeight: 1000,
    handleHeight: 24,
    keyboardHeight: 0,
    isKeyboardVisible: false,
    lowestDetentPosition: 400,
  };
  expect(getBottomSheetVisibleContentHeight({ ...layout, contentPosition: 100 })).toBe(876);
  expect(
    getBottomSheetVisibleContentHeight({
      ...layout,
      contentPosition: 100,
      keyboardHeight: 950,
      isKeyboardVisible: true,
    }),
  ).toBe(0);
  expect(
    getBottomSheetVisibleContentHeight({ ...layout, contentPosition: 100, handleHeight: -999 }),
  ).toBe(0);
  expect(
    getBottomSheetVisibleContentHeight({ ...layout, contentPosition: 100, containerHeight: -999 }),
  ).toBe(0);
});
