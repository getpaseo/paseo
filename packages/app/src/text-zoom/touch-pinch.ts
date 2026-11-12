import type { TextZoomPinchSession } from "./pinch-session";
import { touchDistance } from "./pinch-session";
import type { TextZoomPoint } from "./store";

export interface PinchTouch {
  readonly pageX: number;
  readonly pageY: number;
}

// Two fingers closer than this cannot give a stable scale.
const MIN_START_DISTANCE = 24;

export interface TouchPinchRecognizer {
  /**
   * Takes every touch currently down. Returns true once the touches are a pinch; from then until
   * release the caller treats them as the pinch, not as scrolling or selection.
   */
  move(touches: readonly PinchTouch[]): boolean;
  /** All fingers lifted or the responder was taken: applies and saves the last step. */
  release(): void;
  readonly active: boolean;
}

/**
 * Recognizes a pinch from raw touches, for content whose JS responder already owns every touch,
 * such as the native terminal. Gesture-handler recognizers on an ancestor do not see those
 * touches reliably, so the terminal measures the pinch where its touches already arrive.
 */
export function createTouchPinchRecognizer(
  start: (focal: TextZoomPoint) => TextZoomPinchSession | null,
): TouchPinchRecognizer {
  let session: TextZoomPinchSession | null = null;
  let startDistance = 0;
  return {
    move(touches) {
      if (touches.length < 2) return session !== null;
      const [a, b] = touches;
      const distance = touchDistance(a, b);
      if (!session) {
        if (distance < MIN_START_DISTANCE) return false;
        session = start({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });
        if (!session) return false;
        startDistance = distance;
        return true;
      }
      session.scale(distance / startDistance);
      return true;
    },
    release() {
      session?.end();
      session = null;
    },
    get active() {
      return session !== null;
    },
  };
}
