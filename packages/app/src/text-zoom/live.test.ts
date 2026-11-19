import { describe, expect, it } from "vitest";
import { anchorScrollOffset, createLiveTextZoom, type FrameScheduler } from "./live";

function manualFrames() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler = {
    request(callback) {
      callbacks.set(next, callback);
      return next++;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  };
  return {
    frames,
    pending: () => callbacks.size,
    tick() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback();
    },
  };
}

describe("live text zoom", () => {
  it("applies only when the zoom crosses into a new 5% step", () => {
    const clock = manualFrames();
    const applied: number[] = [];
    const live = createLiveTextZoom({
      startZoom: 1,
      apply: (z) => applied.push(z),
      frames: clock.frames,
    });
    live.update(1.01);
    live.update(1.02);
    expect(clock.pending()).toBe(0);
    live.update(1.04);
    clock.tick();
    live.update(1.06);
    clock.tick();
    live.update(1.12);
    clock.tick();
    expect(applied).toEqual([1.05, 1.1]);
  });

  it("applies at most once per frame, with the latest step", () => {
    const clock = manualFrames();
    const applied: number[] = [];
    const live = createLiveTextZoom({
      startZoom: 1,
      apply: (z) => applied.push(z),
      frames: clock.frames,
    });
    live.update(1.1);
    live.update(1.2);
    live.update(1.3);
    expect(clock.pending()).toBe(1);
    clock.tick();
    expect(applied).toEqual([1.3]);
  });

  it("skips a frame that ends back on the applied step", () => {
    const clock = manualFrames();
    const applied: number[] = [];
    const live = createLiveTextZoom({
      startZoom: 1,
      apply: (z) => applied.push(z),
      frames: clock.frames,
    });
    live.update(1.2);
    live.update(1);
    clock.tick();
    expect(applied).toEqual([]);
  });

  it("applies the pending step when the gesture ends and reports where it ended", () => {
    const clock = manualFrames();
    const applied: number[] = [];
    const live = createLiveTextZoom({
      startZoom: 1.5,
      apply: (z) => applied.push(z),
      frames: clock.frames,
    });
    live.update(9);
    expect(live.finish()).toBe(3);
    expect(applied).toEqual([3]);
    expect(clock.pending()).toBe(0);
    expect(live.finish()).toBe(3);
    expect(applied).toEqual([3]);
  });

  it("keeps the line under the fingers in place as rows grow", () => {
    // Rows 20px → 30px, viewport scrolled to 400, fingers 100px below its top: content at 500
    // moves to 750, so the new offset is 650.
    expect(anchorScrollOffset({ offset: 400, focalY: 100, fromScale: 20, toScale: 30 })).toBe(650);
    expect(anchorScrollOffset({ offset: 0, focalY: 300, fromScale: 30, toScale: 15 })).toBe(0);
  });
});
