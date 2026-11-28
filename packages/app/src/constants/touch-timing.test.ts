import { describe, expect, it } from "vitest";
import * as gpuiTouchTiming from "./touch-timing.gpui";

describe("touch timing per target", () => {
  it("enables touch timing and haptics only on mobile touch platforms, not on web, Electron, or GPUI", async () => {
    const baseTiming = (await import(
      new URL("./touch-timing.ts", import.meta.url).href
    )) as typeof import("./touch-timing");

    expect(baseTiming.resolveTouchTiming({ isNative: true })).toEqual({
      supportsTouchHaptics: true,
      usesTouchLongPressHold: true,
    });
    expect(baseTiming.resolveTouchTiming({ isNative: false })).toEqual({
      supportsTouchHaptics: false,
      usesTouchLongPressHold: false,
    });
    expect({
      supportsTouchHaptics: gpuiTouchTiming.supportsTouchHaptics,
      usesTouchLongPressHold: gpuiTouchTiming.usesTouchLongPressHold,
    }).toEqual({
      supportsTouchHaptics: false,
      usesTouchLongPressHold: false,
    });
    expect("resolveTouchTiming" in gpuiTouchTiming).toBe(false);
  });
});
