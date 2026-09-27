import { describe, expect, it } from "vitest";
import { getContainedFrameRect, getRemotePoint } from "./remote-point";

const FRAME = { width: 1280, height: 720 };
const at = (x: number, y: number) => ({ nativeEvent: { locationX: x, locationY: y } });

describe("getRemotePoint", () => {
  it("draws a desktop frame at its real aspect ratio on a portrait phone", () => {
    expect(getContainedFrameRect(FRAME, { width: 390, height: 700 })).toEqual({
      x: 0,
      y: 240.3125,
      width: 390,
      height: 219.375,
    });
  });

  it("fills the viewport once the remote browser is resized to the phone", () => {
    const viewport = { width: 390, height: 700 };
    expect(getContainedFrameRect(viewport, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 700,
    });
    expect(getRemotePoint(at(195, 350), viewport, viewport)).toEqual({ x: 195, y: 350 });
  });

  it("maps through the letterboxed frame in a tall viewport", () => {
    // 412 wide: scale 412/1280, frame drawn 231.75 tall, centred in 700.
    const viewport = { width: 412, height: 700 };
    expect(getRemotePoint(at(206, 350), FRAME, viewport)).toEqual({ x: 640, y: 360 });
    expect(getRemotePoint(at(0, 234.125), FRAME, viewport)).toEqual({ x: 0, y: 0 });
    expect(getRemotePoint(at(412, 10), FRAME, viewport)).toEqual({ x: 1280, y: 0 });
  });

  it("maps through pillarboxing in a wide viewport", () => {
    const viewport = { width: 1000, height: 360 };
    expect(getRemotePoint(at(180, 0), FRAME, viewport)).toEqual({ x: 0, y: 0 });
    expect(getRemotePoint(at(820, 360), FRAME, viewport)).toEqual({ x: 1280, y: 720 });
  });
});
