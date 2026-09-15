/**
 * The retry lifecycle behind {@link AutocompletePopover}'s anchor measurement, kept out of the
 * component so it can be driven with a fake frame scheduler and a scripted measurement instead of
 * a mounted tree.
 *
 * The popover positions itself against two rects that are produced by the layout engine: the
 * anchor's, and the portal host's. The host registers itself from an effect, so for the first
 * frames after the popover opens either can come back missing or zero-sized. On a platform
 * without keyboard motion nothing re-triggers measurement, so a result discarded there leaves the
 * popover hidden until the window is resized (#4872).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RelativeAnchorRect {
  x: number;
  y: number;
  width: number;
  hostHeight: number;
}

/** The frame scheduler, injected so a test can run the queue by hand. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface MeasurementAttempt {
  measure(): Promise<readonly [Rect, Rect | null]>;
  onMeasured(rect: RelativeAnchorRect): void;
}

export interface MeasurementLoop {
  /** Measure once, retrying on the next frames while the geometry is unusable. */
  run(attempt: MeasurementAttempt): void;
  /** Invalidate work in flight and refill the retry budget. */
  reset(): void;
  /** Invalidate work in flight and stop retrying. */
  stop(): void;
}

/**
 * A missing host, a collapsed host or a zero-width anchor all mean layout has not produced the
 * geometry yet. Positioning against those values hides the popover just as thoroughly as not
 * rendering it, so they are treated as "not measured yet" rather than as a result.
 */
export function isMeasured(anchorRect: Rect, hostRect: Rect | null): hostRect is Rect {
  return hostRect !== null && hostRect.height > 0 && anchorRect.width > 0;
}

export function toRelativeAnchorRect(anchorRect: Rect, hostRect: Rect): RelativeAnchorRect {
  return {
    x: anchorRect.x - hostRect.x,
    y: anchorRect.y - hostRect.y,
    width: anchorRect.width,
    hostHeight: hostRect.height,
  };
}

export function createMeasurementLoop(frames: FrameScheduler, maxRetries: number): MeasurementLoop {
  let generation = 0;
  let retriesLeft = 0;
  let pendingFrame: number | null = null;

  function cancelPendingFrame(): void {
    if (pendingFrame === null) return;
    frames.cancel(pendingFrame);
    pendingFrame = null;
  }

  function run(attempt: MeasurementAttempt): void {
    const startedAt = generation;
    void attempt.measure().then(([anchorRect, hostRect]) => {
      if (startedAt !== generation) return undefined;
      if (!isMeasured(anchorRect, hostRect)) {
        // One retry in flight at a time, so a reset or stop has a single frame to cancel.
        if (retriesLeft > 0 && pendingFrame === null) {
          retriesLeft -= 1;
          pendingFrame = frames.request(() => {
            pendingFrame = null;
            run(attempt);
          });
        }
        return undefined;
      }
      // Usable geometry ends the sequence. Measurements overlap, so a retry queued by an
      // earlier unusable completion would otherwise measure and re-render again after
      // recovery, and a later unusable completion would restart the sequence from there.
      retriesLeft = 0;
      cancelPendingFrame();
      attempt.onMeasured(toRelativeAnchorRect(anchorRect, hostRect));
      return undefined;
    });
  }

  return {
    run,
    reset(): void {
      generation += 1;
      retriesLeft = maxRetries;
      cancelPendingFrame();
    },
    stop(): void {
      generation += 1;
      retriesLeft = 0;
      cancelPendingFrame();
    },
  };
}
