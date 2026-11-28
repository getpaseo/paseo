import { isNative } from "./platform";

export interface TouchTimingCapabilities {
  /** Fire tactile `expo-haptics` feedback on touch interactions. */
  supportsTouchHaptics: boolean;
  /** Require a stationary long-press delay to arm drag or open context menus. */
  usesTouchLongPressHold: boolean;
}

export function resolveTouchTiming(input: { isNative: boolean }): TouchTimingCapabilities {
  return {
    supportsTouchHaptics: input.isNative,
    usesTouchLongPressHold: input.isNative,
  };
}

const TOUCH_TIMING = resolveTouchTiming({ isNative });

export const supportsTouchHaptics = TOUCH_TIMING.supportsTouchHaptics;
export const usesTouchLongPressHold = TOUCH_TIMING.usesTouchLongPressHold;
