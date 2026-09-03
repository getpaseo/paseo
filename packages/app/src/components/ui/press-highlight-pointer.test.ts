import { PointerType } from "react-native-gesture-handler";
import { describe, expect, it, vi } from "vitest";
import { shouldTrackNativePressHighlight } from "./press-highlight-pointer";

vi.mock("react-native-gesture-handler", () => ({
  PointerType: {
    TOUCH: 0,
    STYLUS: 1,
    MOUSE: 2,
  },
}));

describe("native press highlight pointer handling", () => {
  it("yields mouse clicks to the underlying pressable", () => {
    expect(shouldTrackNativePressHighlight(PointerType.MOUSE)).toBe(false);
  });

  it.each([PointerType.TOUCH, PointerType.STYLUS])(
    "keeps immediate feedback for touch-like pointer type %s",
    (pointerType) => {
      expect(shouldTrackNativePressHighlight(pointerType)).toBe(true);
    },
  );
});
