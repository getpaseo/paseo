import { clampTextZoom } from "./model";

/** Runs a callback before the next frame. `requestAnimationFrame` on every platform. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface LiveTextZoom {
  /** Takes the zoom the fingers are at now. Applies it on the next frame if it reached a new step. */
  update(zoom: number): void;
  /** Applies a pending step now and returns the zoom the gesture ended at. */
  finish(): number;
}

/**
 * Turns a gesture's continuous zoom into live size changes. The zoom snaps to 5% steps, and a step
 * applies at most once per frame, latest step wins, so a long transcript or file re-lays out only
 * when the size changes and never more than the display can show.
 */
export function createLiveTextZoom(input: {
  startZoom: number;
  apply(zoom: number): void;
  frames?: FrameScheduler;
}): LiveTextZoom {
  const frames = input.frames ?? animationFrames;
  let applied = clampTextZoom(input.startZoom);
  let pending: number | null = null;
  let frame: number | null = null;

  const flush = () => {
    frame = null;
    const next = pending;
    pending = null;
    if (next === null || next === applied) return;
    applied = next;
    input.apply(next);
  };

  return {
    update(zoom) {
      const step = clampTextZoom(zoom);
      if (step === (pending ?? applied)) return;
      pending = step;
      if (frame === null) frame = frames.request(flush);
    },
    finish() {
      if (frame !== null) frames.cancel(frame);
      flush();
      return applied;
    },
  };
}

/** The scroll offset that keeps the content at `focalY` (from the viewport top) in place. */
export function anchorScrollOffset(input: {
  offset: number;
  focalY: number;
  fromScale: number;
  toScale: number;
}): number {
  if (input.fromScale <= 0) return input.offset;
  const contentY = input.offset + input.focalY;
  return Math.max(0, (contentY * input.toScale) / input.fromScale - input.focalY);
}
