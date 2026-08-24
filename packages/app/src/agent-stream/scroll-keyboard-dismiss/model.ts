/**
 * Pure state machine for the chat history's flick-to-dismiss gesture.
 *
 * Native keyboardDismissMode cannot express this interaction: "on-drag"
 * dismisses on the first pixel, while "interactive" behaves incorrectly on an
 * inverted list. We therefore classify the list's existing scroll gesture at
 * release instead of introducing a competing pan recognizer.
 */

const DISMISS_VELOCITY_POINTS_PER_MS = 1.5;
const RELEASE_SAMPLE_MIN_MS = 30;

/**
 * The subset of a native scroll event used by the classifier. React Native's
 * type omits `nativeEvent.timestamp`, although iOS and Android both send it.
 */
export interface ScrollKeyboardDismissEvent {
  timeStamp: number;
  nativeEvent: {
    contentOffset: { y: number };
    timestamp?: number;
  };
}

interface DragSamples {
  startTs: number;
  startY: number;
  sampleTs: number;
  sampleY: number;
  previousSampleTs: number;
  previousSampleY: number;
}

export type ScrollKeyboardDismissGesture =
  | { phase: "idle" }
  | { phase: "dragging"; samples: DragSamples };

export const IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE: ScrollKeyboardDismissGesture = Object.freeze({
  phase: "idle",
});

function resolveEventTimeMs(event: ScrollKeyboardDismissEvent): number {
  const nativeTimestamp = event.nativeEvent.timestamp;
  if (typeof nativeTimestamp === "number" && nativeTimestamp > 0) {
    return nativeTimestamp;
  }
  return event.timeStamp;
}

export function beginDrag(event: ScrollKeyboardDismissEvent): ScrollKeyboardDismissGesture {
  const timestamp = resolveEventTimeMs(event);
  const offsetY = event.nativeEvent.contentOffset.y;
  return {
    phase: "dragging",
    samples: {
      startTs: timestamp,
      startY: offsetY,
      sampleTs: timestamp,
      sampleY: offsetY,
      previousSampleTs: 0,
      previousSampleY: 0,
    },
  };
}

export function recordScroll(
  gesture: ScrollKeyboardDismissGesture,
  event: ScrollKeyboardDismissEvent,
): ScrollKeyboardDismissGesture {
  if (gesture.phase === "idle") {
    return gesture;
  }

  const timestamp = resolveEventTimeMs(event);
  if (timestamp - gesture.samples.sampleTs < RELEASE_SAMPLE_MIN_MS) {
    return gesture;
  }

  const { samples } = gesture;
  return {
    phase: "dragging",
    samples: {
      startTs: samples.startTs,
      startY: samples.startY,
      sampleTs: timestamp,
      sampleY: event.nativeEvent.contentOffset.y,
      previousSampleTs: samples.sampleTs,
      previousSampleY: samples.sampleY,
    },
  };
}

export function releaseDrag(
  gesture: ScrollKeyboardDismissGesture,
  event: ScrollKeyboardDismissEvent,
): { gesture: ScrollKeyboardDismissGesture; shouldDismiss: boolean } {
  if (gesture.phase === "idle") {
    return { gesture, shouldDismiss: false };
  }

  const releaseTs = resolveEventTimeMs(event);
  const releaseY = event.nativeEvent.contentOffset.y;
  const { samples } = gesture;

  // The release event carries the gesture's true endpoint. The final onScroll
  // event can still be stale when a short flick lands.
  let spanStartTs = samples.startTs;
  let spanStartY = samples.startY;
  if (releaseTs - samples.sampleTs >= RELEASE_SAMPLE_MIN_MS) {
    spanStartTs = samples.sampleTs;
    spanStartY = samples.sampleY;
  } else if (samples.previousSampleTs > 0) {
    spanStartTs = samples.previousSampleTs;
    spanStartY = samples.previousSampleY;
  }

  const spanDurationMs = releaseTs - spanStartTs;
  const releaseVelocity = spanDurationMs > 0 ? (releaseY - spanStartY) / spanDurationMs : 0;

  return {
    gesture: IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE,
    shouldDismiss: releaseVelocity > DISMISS_VELOCITY_POINTS_PER_MS,
  };
}
