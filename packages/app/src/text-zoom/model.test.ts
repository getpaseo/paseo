import { describe, expect, it } from "vitest";
import {
  clampTextZoom,
  formatTextZoom,
  parseStoredTextZoom,
  pinchTextZoom,
  wheelTextZoom,
  zoomedFontSize,
} from "./model";

describe("text zoom model", () => {
  it("snaps to 5% steps within 50% and 300%", () => {
    expect(clampTextZoom(1.13)).toBe(1.15);
    expect(clampTextZoom(0.1)).toBe(0.5);
    expect(clampTextZoom(9)).toBe(3);
    expect(clampTextZoom(Number.NaN)).toBe(1);
  });

  it("scales a pinch from the zoom it started at", () => {
    expect(pinchTextZoom(1, 1.5)).toBe(1.5);
    expect(pinchTextZoom(1.5, 0.5)).toBe(0.75);
    expect(pinchTextZoom(2, 4)).toBe(3);
  });

  it("zooms in for a ctrl+wheel pinch out and back for the same pinch in", () => {
    const bigger = wheelTextZoom(1, -20);
    expect(bigger).toBeGreaterThan(1);
    expect(wheelTextZoom(bigger, 20)).toBeCloseTo(1, 10);
    expect(wheelTextZoom(0.5, 500)).toBe(0.5);
  });

  it("draws whole-pixel font sizes", () => {
    expect(zoomedFontSize(12, 1.15)).toBe(14);
    expect(zoomedFontSize(16, 0.5)).toBe(8);
    expect(formatTextZoom(1.15)).toBe("115%");
  });

  it("reads saved zooms and drops anything unreadable", () => {
    // Zooms saved before file views had one load with files at 100%.
    expect(parseStoredTextZoom('{"chat":1.25,"terminal":0.8}')).toEqual({
      chat: 1.25,
      terminal: 0.8,
      files: 1,
    });
    expect(parseStoredTextZoom('{"chat":"big","terminal":12,"files":0.75}')).toEqual({
      chat: 1,
      terminal: 3,
      files: 0.75,
    });
    expect(parseStoredTextZoom("not json")).toEqual({ chat: 1, terminal: 1, files: 1 });
    expect(parseStoredTextZoom(null)).toEqual({ chat: 1, terminal: 1, files: 1 });
  });
});
