import type { TouchTimingCapabilities } from "./touch-timing";

export function resolveTouchTiming(_input: { isNative: boolean }): TouchTimingCapabilities {
  return {
    supportsTouchHaptics: false,
    usesTouchLongPressHold: false,
  };
}

export const supportsTouchHaptics = false;
export const usesTouchLongPressHold = false;
