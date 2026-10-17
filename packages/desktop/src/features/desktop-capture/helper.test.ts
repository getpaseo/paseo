import { describe, expect, it } from "vitest";
import { parseHelperEvent } from "./helper.js";

describe("desktop capture helper boundary", () => {
  it("accepts hold lifecycle events and rejects unknown phases", () => {
    for (const phase of ["began", "ended", "cancelled"]) {
      expect(parseHelperEvent(JSON.stringify({ event: "gesture", id: "hold", phase }))).toEqual({
        event: "gesture",
        id: "hold",
        phase,
      });
    }
    expect(() => parseHelperEvent('{"event":"gesture","id":"hold","phase":"send"}')).toThrow();
  });
  it("accepts a capture with explicit display coordinates and pixels", () => {
    expect(
      parseHelperEvent(
        JSON.stringify({
          event: "capture",
          id: "a",
          png: "aGVsbG8=",
          context: {},
          display: { id: 1, x: -100, y: 0, width: 100, height: 80 },
          width: 200,
          height: 160,
          captureMs: 9,
        }),
      ).event,
    ).toBe("capture");
  });
  it("rejects malformed images, unbounded dimensions and unknown events", () => {
    expect(() => parseHelperEvent('{"event":"capture","id":"a"}')).toThrow();
    expect(() => parseHelperEvent('{"event":"action","command":"click"}')).toThrow();
  });
  it("accepts OCR and permission failures separately from the captured draft", () => {
    expect(parseHelperEvent('{"event":"ocr","id":"a","text":"project"}')).toEqual({
      event: "ocr",
      id: "a",
      text: "project",
    });
    expect(parseHelperEvent('{"event":"error","id":"a","error":"capture_permission"}').event).toBe(
      "error",
    );
  });
});
