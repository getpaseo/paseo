import { describe, expect, it } from "vitest";
import {
  getBottomSheetSafeAreaPaddingBottom,
  getBottomSheetVisibleContentHeight,
} from "./visible-frame-layout";

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

  it("ignores non-positive keyboard heights", () => {
    const layout = {
      containerHeight: 874,
      contentPosition: 88,
      handleHeight: 24,
      keyboardHeight: -10,
      isKeyboardVisible: true,
    };

    expect(getBottomSheetVisibleContentHeight(layout)).toBe(762);
  });
});

describe("getBottomSheetSafeAreaPaddingBottom", () => {
  it("keeps full safe-area clearance while the keyboard is hidden, even with retained keyboard height", () => {
    expect(
      getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: 344,
        isKeyboardVisible: false,
        safeAreaBottom: 48,
      }),
    ).toBe(48);
  });

  it("keeps full safe-area clearance during Gorhom's first-open frame before heightWithinContainer is populated", () => {
    expect(
      getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: 0,
        isKeyboardVisible: true,
        safeAreaBottom: 48,
      }),
    ).toBe(48);
  });

  it("drops safe-area clearance to 0 when the keyboard height covers the bottom safe area", () => {
    expect(
      getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: 344,
        isKeyboardVisible: true,
        safeAreaBottom: 48,
      }),
    ).toBe(0);
  });

  it("preserves remaining safe-area clearance when keyboard height is smaller than the bottom inset", () => {
    expect(
      getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: 20,
        isKeyboardVisible: true,
        safeAreaBottom: 48,
      }),
    ).toBe(28);
  });

  it("returns 0 when there is no bottom safe-area inset", () => {
    expect(
      getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: 0,
        isKeyboardVisible: false,
        safeAreaBottom: 0,
      }),
    ).toBe(0);
  });

  it("holds the invariant that visible frame height + paddingBottom never places the footer inside the bottom safe area across keyboard open/close transitions", () => {
    const containerHeight = 1608;
    const contentPosition = 161;
    const handleHeight = 48;
    const safeAreaBottom = 96;
    const restingContentBottom = containerHeight - safeAreaBottom;

    // Sequence matching real Android/iOS Gorhom keyboard transitions:
    // 1. Resting closed
    // 2. First open intermediate state (status=SHOWN before heightWithinContainer updates)
    // 3. Open settled (heightWithinContainer = 598)
    // 4. Close (status=HIDDEN while heightWithinContainer retains 598)
    // 5. Partial accessory bar (heightWithinContainer = 40 < safeAreaBottom)
    const transitions = [
      { isKeyboardVisible: false, keyboardHeight: 0, expectedContentBottom: restingContentBottom },
      { isKeyboardVisible: true, keyboardHeight: 0, expectedContentBottom: restingContentBottom },
      {
        isKeyboardVisible: true,
        keyboardHeight: 598,
        expectedContentBottom: containerHeight - 598,
      },
      {
        isKeyboardVisible: false,
        keyboardHeight: 598,
        expectedContentBottom: restingContentBottom,
      },
      { isKeyboardVisible: true, keyboardHeight: 40, expectedContentBottom: restingContentBottom },
    ];

    for (const step of transitions) {
      const height = getBottomSheetVisibleContentHeight({
        containerHeight,
        contentPosition,
        handleHeight,
        keyboardHeight: step.keyboardHeight,
        isKeyboardVisible: step.isKeyboardVisible,
      });
      const paddingBottom = getBottomSheetSafeAreaPaddingBottom({
        keyboardHeight: step.keyboardHeight,
        isKeyboardVisible: step.isKeyboardVisible,
        safeAreaBottom,
      });
      // Inside a border-box frame at `contentPosition + handleHeight`, the bottom of the footer
      // sits at `contentPosition + handleHeight + height - paddingBottom`.
      const footerBottomY = contentPosition + handleHeight + height - paddingBottom;
      expect(footerBottomY).toBe(step.expectedContentBottom);
      expect(footerBottomY).toBeLessThanOrEqual(restingContentBottom);
    }
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
