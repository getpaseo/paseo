import { describe, expect, it } from "vitest";
import {
  EMPTY_SCREENCAST_VIEW,
  retainFrame,
  sameScreencastSize,
  screencastSize,
  subscriptionChange,
  subscriptionErrorView,
} from "./screencast-policy";

describe("browser screencast policy", () => {
  it.each([null, { width: 0, height: 0 }])("waits for a usable pane size", (pane) => {
    expect(screencastSize(pane, 1)).toBeNull();
  });

  it("subscribes only when the quantized pane size changes", () => {
    const initial = screencastSize({ width: 1000, height: 800 }, 1);
    expect(initial).toEqual({ maxWidth: 960, maxHeight: 960 });
    expect(sameScreencastSize(initial, screencastSize({ width: 1004, height: 803 }, 1))).toBe(true);
    expect(screencastSize({ width: 1600, height: 1200 }, 1)).toEqual({
      maxWidth: 1600,
      maxHeight: 1280,
    });
  });

  it("caps retina requests at the host pixel budget", () => {
    expect(screencastSize({ width: 2000, height: 1500 }, 2)).toEqual({
      maxWidth: 2240,
      maxHeight: 1600,
    });
  });

  it("resubscribes after reconnect but not for the replayed or repeated connected state", () => {
    const size = { maxWidth: 960, maxHeight: 960 };
    expect(subscriptionChange(null, true, size)).toBeUndefined();
    expect(subscriptionChange(true, true, size)).toBeUndefined();
    expect(subscriptionChange(false, true, size)).toEqual(size);
    expect(subscriptionChange(false, true, null)).toBeUndefined();
  });

  it("stops hidden streams and resumes at their latest size", () => {
    const latest = { maxWidth: 1600, maxHeight: 1280 };
    expect(subscriptionChange(true, true, latest, true)).toBeUndefined();
    expect(subscriptionChange(true, false, latest, true)).toBe("unsubscribe");
    expect(subscriptionChange(false, true, latest, true)).toEqual(latest);
  });

  it("shows only the latest subscription refusal", () => {
    expect(subscriptionErrorView("Browser not found", 2, 2)).toEqual({
      ...EMPTY_SCREENCAST_VIEW,
      error: "Browser not found",
    });
    expect(subscriptionErrorView("stale", 1, 2)).toBeUndefined();
    expect(subscriptionErrorView(null, 2, 2)).toBeUndefined();
  });

  it("shows frames and retains only the newest two", () => {
    let frames: string[] = [];
    let released: string[] = [];
    for (const frame of ["frame-1", "frame-2", "frame-3"]) {
      const update = retainFrame(frames, frame);
      frames = update[0];
      released.push(...update[1]);
    }
    expect(frames).toEqual(["frame-2", "frame-3"]);
    expect(released).toEqual(["frame-1"]);
  });
});
