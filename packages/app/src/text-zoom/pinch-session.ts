import { createLiveTextZoom, type FrameScheduler } from "./live";
import type { TextZoomSurface } from "./model";
import {
  applyPinchTextZoom,
  beginTextZoomPinch,
  endTextZoomPinch,
  getTextZoom,
  type TextZoomPoint,
} from "./store";

export interface TextZoomPinchSession {
  /** The fingers' scale since the pinch began. */
  scale(gestureScale: number): void;
  /** An absolute zoom, for input that accumulates its own, such as ctrl+wheel. */
  zoomTo(zoom: number): void;
  readonly startZoom: number;
  /** Applies the last step and saves it. Idempotent. */
  end(): void;
}

/**
 * One pinch, whatever recognized it. The size changes live in 5% steps, at most once a frame, and
 * is saved once when the pinch ends.
 */
export function startTextZoomPinch(
  surface: TextZoomSurface,
  focal: TextZoomPoint | null,
  frames?: FrameScheduler,
): TextZoomPinchSession {
  const startZoom = getTextZoom(surface);
  beginTextZoomPinch(surface, focal);
  const live = createLiveTextZoom({ startZoom, apply: applyPinchTextZoom, frames });
  let ended = false;
  return {
    startZoom,
    scale(gestureScale) {
      if (!ended && Number.isFinite(gestureScale) && gestureScale > 0) {
        live.update(startZoom * gestureScale);
      }
    },
    zoomTo(zoom) {
      if (!ended) live.update(zoom);
    },
    end() {
      if (ended) return;
      ended = true;
      live.finish();
      endTextZoomPinch();
    },
  };
}

/** The distance between two touches, for recognizers that track raw touches. */
export function touchDistance(
  a: { pageX: number; pageY: number },
  b: { pageX: number; pageY: number },
): number {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}
