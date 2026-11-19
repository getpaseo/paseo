import { describe, expect, it } from "vitest";
import type { TextZoomPinchSession } from "./pinch-session";
import { createTouchPinchRecognizer } from "./touch-pinch";

function recordingSession() {
  const scales: number[] = [];
  let ended = 0;
  const session: TextZoomPinchSession = {
    startZoom: 1,
    scale: (value) => scales.push(value),
    zoomTo: () => {},
    end: () => {
      ended += 1;
    },
  };
  return { session, scales, ended: () => ended };
}

const touch = (pageX: number, pageY = 0) => ({ pageX, pageY });

describe("touch pinch recognizer", () => {
  it("leaves one finger to scrolling and selection", () => {
    const recognizer = createTouchPinchRecognizer(() => recordingSession().session);
    expect(recognizer.move([touch(10)])).toBe(false);
    expect(recognizer.active).toBe(false);
  });

  it("scales by how far the fingers moved apart and ends once on release", () => {
    const record = recordingSession();
    const focals: Array<{ x: number; y: number }> = [];
    const recognizer = createTouchPinchRecognizer((focal) => {
      focals.push(focal);
      return record.session;
    });
    expect(recognizer.move([touch(100, 50), touch(200, 50)])).toBe(true);
    recognizer.move([touch(50, 50), touch(250, 50)]);
    // A finger lifting keeps the touches a pinch, so they do not start a scroll.
    expect(recognizer.move([touch(50, 50)])).toBe(true);
    recognizer.release();
    recognizer.release();
    expect(focals).toEqual([{ x: 150, y: 50 }]);
    expect(record.scales).toEqual([2]);
    expect(record.ended()).toBe(1);
    expect(recognizer.active).toBe(false);
  });

  it("does nothing while pinch is off for the surface", () => {
    const recognizer = createTouchPinchRecognizer(() => null);
    expect(recognizer.move([touch(0), touch(200)])).toBe(false);
  });

  it("waits for fingers far enough apart to give a stable scale", () => {
    const record = recordingSession();
    const recognizer = createTouchPinchRecognizer(() => record.session);
    expect(recognizer.move([touch(0), touch(10)])).toBe(false);
    expect(recognizer.move([touch(0), touch(100)])).toBe(true);
  });
});
