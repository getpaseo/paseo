import { describe, expect, it } from "vitest";
import {
  beginDragSpeedSamples,
  recordDragSpeedSample,
  resolveDragReleaseSpeed,
  resolveScrollEventTimeMs,
  type DragSpeedSamples,
} from "./scroll-keyboard-dismiss";

const MIN_SAMPLE_MS = 30;
const DISMISS_VELOCITY = 1.5;

function dragThrough(
  points: Array<{ ts: number; y: number }>,
  start: { ts: number; y: number },
): DragSpeedSamples {
  return points.reduce(
    (samples, point) => recordDragSpeedSample(samples, point.ts, point.y, MIN_SAMPLE_MS),
    beginDragSpeedSamples(start.ts, start.y),
  );
}

describe("resolveDragReleaseSpeed", () => {
  it("reports a slow read-scroll below the dismiss threshold", () => {
    const samples = dragThrough(
      [
        { ts: 1040, y: 8 },
        { ts: 1080, y: 16 },
        { ts: 1120, y: 24 },
      ],
      { ts: 1000, y: 0 },
    );

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1160,
      releaseY: 32,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(0.2);
    expect(speed > DISMISS_VELOCITY).toBe(false);
  });

  it("reports a flick above the dismiss threshold", () => {
    const samples = dragThrough([{ ts: 1040, y: 120 }], { ts: 1000, y: 0 });

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1080,
      releaseY: 240,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(3);
    expect(speed > DISMISS_VELOCITY).toBe(true);
  });

  it("stays negative when the inverted list moves back toward the newest messages", () => {
    const samples = dragThrough([{ ts: 1040, y: -120 }], { ts: 1000, y: 0 });

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1080,
      releaseY: -240,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(-3);
    expect(speed > DISMISS_VELOCITY).toBe(false);
  });

  it("keeps a fast-but-decelerating drag below the threshold it would pass on average", () => {
    // 600 points over 300ms averages 2/ms, but the last stretch crawls.
    const samples = dragThrough(
      [
        { ts: 1100, y: 500 },
        { ts: 1200, y: 590 },
        { ts: 1270, y: 598 },
      ],
      { ts: 1000, y: 0 },
    );

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1300,
      releaseY: 600,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(0.0666, 3);
    expect(speed > DISMISS_VELOCITY).toBe(false);
  });

  it("measures the whole drag when the gesture was too short to sample", () => {
    const samples = beginDragSpeedSamples(1000, 0);

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1020,
      releaseY: 60,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(3);
    expect(speed > DISMISS_VELOCITY).toBe(true);
  });

  it("steps back a sample when the release lands right after one", () => {
    const samples = dragThrough(
      [
        { ts: 1040, y: 120 },
        { ts: 1075, y: 225 },
      ],
      { ts: 1000, y: 0 },
    );

    // Only 5ms since the last sample: too short to measure on its own, so the
    // span reaches back to the previous one instead of collapsing to zero.
    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1080,
      releaseY: 240,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(3);
    expect(speed > DISMISS_VELOCITY).toBe(true);
  });

  it("reports no speed when the release carries no measurable span", () => {
    const samples = beginDragSpeedSamples(1000, 0);

    expect(
      resolveDragReleaseSpeed({
        samples,
        releaseTs: 1000,
        releaseY: 90,
        minSampleMs: MIN_SAMPLE_MS,
      }),
    ).toBe(0);
  });
});

describe("resolveScrollEventTimeMs", () => {
  it("prefers the native payload timestamp over the dispatch clock", () => {
    expect(
      resolveScrollEventTimeMs({
        timeStamp: 1761000000000,
        nativeEvent: { contentOffset: { y: 120 }, timestamp: 84231.5 },
      }),
    ).toBe(84231.5);
  });

  it("falls back to the synthetic timestamp when the payload omits one", () => {
    expect(
      resolveScrollEventTimeMs({
        timeStamp: 1761000000000,
        nativeEvent: { contentOffset: { y: 120 } },
      }),
    ).toBe(1761000000000);
  });
});

describe("recordDragSpeedSample", () => {
  it("ignores events that arrive before the minimum span", () => {
    const samples = beginDragSpeedSamples(1000, 0);

    expect(recordDragSpeedSample(samples, 1029, 400, MIN_SAMPLE_MS)).toBe(samples);
  });

  it("does not turn a burst of delayed callbacks into a flick", () => {
    // A calm drag whose callbacks are delivered late and bunched together: the
    // event timestamps still describe the real gesture, so the speed stays low.
    const samples = dragThrough(
      [
        { ts: 1200, y: 40 },
        { ts: 1400, y: 80 },
      ],
      { ts: 1000, y: 0 },
    );

    const speed = resolveDragReleaseSpeed({
      samples,
      releaseTs: 1600,
      releaseY: 120,
      minSampleMs: MIN_SAMPLE_MS,
    });

    expect(speed).toBeCloseTo(0.2);
    expect(speed > DISMISS_VELOCITY).toBe(false);
  });
});
