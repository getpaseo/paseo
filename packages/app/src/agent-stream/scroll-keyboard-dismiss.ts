/**
 * Speed measurement for the chat history's flick-to-dismiss gesture.
 *
 * All timestamps must describe the native gesture, never callback dispatch:
 * when the JS thread is busy the callbacks arrive in a burst long after the
 * gesture, and dispatch spacing then reads a calm scroll as a flick.
 */

/**
 * The parts of a scroll event this module reads. `timestamp` is absent from
 * `NativeScrollEvent` even though every platform sends it, so it is declared
 * here as optional alongside a field the platform type does declare.
 */
interface ScrollEventTiming {
  timeStamp: number;
  nativeEvent: {
    contentOffset: { y: number };
    timestamp?: number;
  };
}

/**
 * Milliseconds from the native scroll payload, which every platform stamps when
 * it creates the event (`CACurrentMediaTime` on iOS, `uptimeMillis` on Android,
 * the touch time in Fabric). The synthetic `timeStamp` reads a differently
 * spelled key, so it silently falls back to the dispatch clock — only usable
 * when the native value is missing.
 */
export function resolveScrollEventTimeMs(event: ScrollEventTiming): number {
  const nativeTimestamp = event.nativeEvent.timestamp;
  if (typeof nativeTimestamp === "number" && nativeTimestamp > 0) {
    return nativeTimestamp;
  }
  return event.timeStamp;
}
export interface DragSpeedSamples {
  startTs: number;
  startY: number;
  sampleTs: number;
  sampleY: number;
  previousSampleTs: number;
  previousSampleY: number;
}

/** Shareable idle value: these helpers never mutate a sample set in place. */
export const IDLE_DRAG_SPEED_SAMPLES: DragSpeedSamples = Object.freeze({
  startTs: 0,
  startY: 0,
  sampleTs: 0,
  sampleY: 0,
  previousSampleTs: 0,
  previousSampleY: 0,
});

export function beginDragSpeedSamples(ts: number, y: number): DragSpeedSamples {
  return {
    startTs: ts,
    startY: y,
    sampleTs: ts,
    sampleY: y,
    previousSampleTs: 0,
    previousSampleY: 0,
  };
}

/**
 * Keeps the last two samples that are at least `minSampleMs` apart, so the
 * gesture's speed near release can be read without trusting a single event.
 */
export function recordDragSpeedSample(
  samples: DragSpeedSamples,
  ts: number,
  y: number,
  minSampleMs: number,
): DragSpeedSamples {
  if (ts - samples.sampleTs < minSampleMs) {
    return samples;
  }
  return {
    startTs: samples.startTs,
    startY: samples.startY,
    sampleTs: ts,
    sampleY: y,
    previousSampleTs: samples.sampleTs,
    previousSampleY: samples.sampleY,
  };
}

/**
 * Signed speed over the drag's final stretch, in points per millisecond.
 * Positive means the inverted list moved toward older history.
 *
 * Measuring at release rather than averaging the whole drag is what separates a
 * flick (finger lifted mid-motion) from a fast but controlled read-scroll, which
 * decelerates before lifting. Prefers the most recent span long enough to be
 * reliable, steps back one sample when the release landed right after a sample,
 * and falls back to the whole drag for gestures too short to have sampled.
 */
export function resolveDragReleaseSpeed(input: {
  samples: DragSpeedSamples;
  releaseTs: number;
  releaseY: number;
  minSampleMs: number;
}): number {
  const { samples, releaseTs, releaseY, minSampleMs } = input;

  let spanStartTs = samples.startTs;
  let spanStartY = samples.startY;
  if (releaseTs - samples.sampleTs >= minSampleMs) {
    spanStartTs = samples.sampleTs;
    spanStartY = samples.sampleY;
  } else if (samples.previousSampleTs > 0) {
    spanStartTs = samples.previousSampleTs;
    spanStartY = samples.previousSampleY;
  }

  const spanDurationMs = releaseTs - spanStartTs;
  if (spanDurationMs <= 0) {
    return 0;
  }
  return (releaseY - spanStartY) / spanDurationMs;
}
