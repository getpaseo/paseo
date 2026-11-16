import { describe, expect, it } from "vitest";
import { getBottomSheetVisibleContentHeight, getMotionFrameLayout } from "./visible-frame-layout";

describe("getMotionFrameLayout", () => {
  it("keeps the body at the largest viewport while a sheet moves and positions the footer at the visible edge", () => {
    expect(getMotionFrameLayout(576, 876, true)).toEqual({ bodyHeight: 876, footerOffset: -300 });
    expect(getMotionFrameLayout(726, 876, true)).toEqual({ bodyHeight: 876, footerOffset: -150 });
    expect(getMotionFrameLayout(876, 876, true)).toEqual({ bodyHeight: 876, footerOffset: 0 });
  });

  it("gives the scroller its actual viewport at rest, including after a cancellation", () => {
    expect(getMotionFrameLayout(576, 876, false)).toEqual({ bodyHeight: 576, footerOffset: 0 });
    expect(getMotionFrameLayout(876, 876, false)).toEqual({ bodyHeight: 876, footerOffset: 0 });
  });

  it("does not clip the body when the keyboard or a temporary position makes the visible area larger", () => {
    expect(getMotionFrameLayout(900, 876, true)).toEqual({ bodyHeight: 900, footerOffset: 0 });
    expect(getMotionFrameLayout(0, 0, true)).toEqual({ bodyHeight: 0, footerOffset: 0 });
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
