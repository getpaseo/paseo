import { describe, expect, it } from "vitest";
import {
  beginDrag,
  IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE,
  recordScroll,
  releaseDrag,
  type ScrollKeyboardDismissEvent,
  type ScrollKeyboardDismissGesture,
} from "./model";

interface Point {
  ts: number;
  y: number;
  nativeTs?: number | null;
}

function event(point: Point): ScrollKeyboardDismissEvent {
  return {
    timeStamp: point.ts,
    nativeEvent: {
      contentOffset: { y: point.y },
      ...(point.nativeTs === null ? {} : { timestamp: point.nativeTs ?? point.ts }),
    },
  };
}

function dragThrough(start: Point, points: Point[]): ScrollKeyboardDismissGesture {
  return points.reduce(
    (gesture, point) => recordScroll(gesture, event(point)),
    beginDrag(event(start)),
  );
}

function shouldDismiss(start: Point, points: Point[], release: Point): boolean {
  return releaseDrag(dragThrough(start, points), event(release)).shouldDismiss;
}

describe("scroll keyboard dismissal", () => {
  it("keeps the keyboard up for a slow read-scroll", () => {
    expect(
      shouldDismiss(
        { ts: 1000, y: 0 },
        [
          { ts: 1040, y: 8 },
          { ts: 1080, y: 16 },
          { ts: 1120, y: 24 },
        ],
        { ts: 1160, y: 32 },
      ),
    ).toBe(false);
  });

  it("dismisses for an upward flick", () => {
    expect(shouldDismiss({ ts: 1000, y: 0 }, [{ ts: 1040, y: 120 }], { ts: 1080, y: 240 })).toBe(
      true,
    );
  });

  it("keeps the keyboard up when the inverted list moves toward newer messages", () => {
    expect(shouldDismiss({ ts: 1000, y: 0 }, [{ ts: 1040, y: -120 }], { ts: 1080, y: -240 })).toBe(
      false,
    );
  });

  it("keeps a fast-but-decelerating drag below the release threshold", () => {
    expect(
      shouldDismiss(
        { ts: 1000, y: 0 },
        [
          { ts: 1100, y: 500 },
          { ts: 1200, y: 590 },
          { ts: 1270, y: 598 },
        ],
        { ts: 1300, y: 600 },
      ),
    ).toBe(false);
  });

  it("uses the whole drag when the gesture is too short to sample", () => {
    expect(shouldDismiss({ ts: 1000, y: 0 }, [], { ts: 1020, y: 60 })).toBe(true);
  });

  it("steps back a sample when release lands immediately after one", () => {
    expect(
      shouldDismiss(
        { ts: 1000, y: 0 },
        [
          { ts: 1040, y: 120 },
          { ts: 1075, y: 225 },
        ],
        { ts: 1080, y: 240 },
      ),
    ).toBe(true);
  });

  it("keeps the keyboard up when release has no measurable time span", () => {
    expect(shouldDismiss({ ts: 1000, y: 0 }, [], { ts: 1000, y: 90 })).toBe(false);
  });

  it("ignores scroll events that arrive before the minimum sample span", () => {
    expect(shouldDismiss({ ts: 1000, y: 0 }, [{ ts: 1029, y: 1000 }], { ts: 1060, y: 1000 })).toBe(
      true,
    );
  });

  it("uses native gesture time when delayed callbacks arrive in a burst", () => {
    expect(
      shouldDismiss(
        { ts: 5000, nativeTs: 1000, y: 0 },
        [
          { ts: 5001, nativeTs: 1200, y: 40 },
          { ts: 5002, nativeTs: 1400, y: 80 },
        ],
        { ts: 5003, nativeTs: 1600, y: 120 },
      ),
    ).toBe(false);
  });

  it("falls back to synthetic event time when native time is absent", () => {
    expect(
      shouldDismiss({ ts: 1000, nativeTs: null, y: 0 }, [{ ts: 1040, nativeTs: null, y: 120 }], {
        ts: 1080,
        nativeTs: null,
        y: 240,
      }),
    ).toBe(true);
  });

  it("ignores scroll and release events without a matching drag", () => {
    const idle = recordScroll(IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE, event({ ts: 1000, y: 200 }));
    expect(idle).toBe(IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE);
    expect(releaseDrag(idle, event({ ts: 1010, y: 300 })).shouldDismiss).toBe(false);
  });

  it("returns to idle after release", () => {
    const release = releaseDrag(beginDrag(event({ ts: 1000, y: 0 })), event({ ts: 1020, y: 60 }));
    expect(release.gesture).toBe(IDLE_SCROLL_KEYBOARD_DISMISS_GESTURE);
  });
});
