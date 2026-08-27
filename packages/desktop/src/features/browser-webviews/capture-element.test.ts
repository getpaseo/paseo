import { describe, expect, it } from "vitest";
import {
  buildGuestCaptureMetricsScript,
  captureElementScreenshot,
  computeCalibratedCropRect,
  normalizeBrowserCaptureRect,
  parseGuestCaptureMetrics,
  type GuestCaptureMetrics,
} from "./capture-element.js";

describe("normalizeBrowserCaptureRect", () => {
  it("rounds and clamps a valid rect", () => {
    expect(normalizeBrowserCaptureRect({ x: 10.4, y: -3.6, width: 100.5, height: 50.2 })).toEqual({
      x: 10,
      y: 0,
      width: 101,
      height: 50,
    });
  });

  it("rejects non-finite or non-positive rects", () => {
    expect(normalizeBrowserCaptureRect(null)).toBeNull();
    expect(normalizeBrowserCaptureRect({ x: NaN, y: 0, width: 10, height: 10 })).toBeNull();
    expect(normalizeBrowserCaptureRect({ x: 0, y: 0, width: 0, height: 10 })).toBeNull();
    expect(normalizeBrowserCaptureRect({ x: 0, y: 0, width: "10", height: 10 })).toBeNull();
  });
});

describe("buildGuestCaptureMetricsScript", () => {
  it("embeds the selector as a JSON literal", () => {
    const script = buildGuestCaptureMetricsScript('div.foo[data-x="a\'b"]');
    expect(script).toContain(JSON.stringify('div.foo[data-x="a\'b"]'));
  });

  it("skips element measurement when no selector is given", () => {
    expect(buildGuestCaptureMetricsScript(null)).toContain("var selector = null;");
  });
});

describe("parseGuestCaptureMetrics", () => {
  it("parses viewport size and fresh rect", () => {
    expect(
      parseGuestCaptureMetrics(
        JSON.stringify({
          viewportWidth: 1280,
          viewportHeight: 800,
          rect: { x: 1.2, y: 3.4, width: 100, height: 40 },
        }),
      ),
    ).toEqual({
      viewportWidth: 1280,
      viewportHeight: 800,
      freshRect: { x: 1, y: 3, width: 100, height: 40 },
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseGuestCaptureMetrics(null)).toBeNull();
    expect(parseGuestCaptureMetrics("not json")).toBeNull();
    expect(
      parseGuestCaptureMetrics(JSON.stringify({ viewportWidth: 0, viewportHeight: 800 })),
    ).toBeNull();
  });
});

describe("computeCalibratedCropRect", () => {
  const metrics: GuestCaptureMetrics = {
    viewportWidth: 1000,
    viewportHeight: 500,
    freshRect: null,
  };

  it("scales the CSS rect by the frame-to-viewport ratio (device scale factor)", () => {
    // A 2x frame of a 1000x500 CSS viewport.
    const crop = computeCalibratedCropRect({ x: 100, y: 50, width: 200, height: 100 }, metrics, {
      width: 2000,
      height: 1000,
    });
    expect(crop).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("handles page zoom on top of device scale", () => {
    // zoom 1.25 x dpr 1.25 -> effective 1.5625
    const crop = computeCalibratedCropRect(
      { x: 80, y: 64, width: 160, height: 96 },
      { ...metrics, viewportWidth: 800 },
      { width: 1250, height: 781.25 as number },
    );
    // scaleX = 1250/800 = 1.5625, scaleY falls back per-axis
    expect(crop).toEqual({ x: 125, y: 100, width: 250, height: 150 });
  });

  it("clamps the crop to the frame bounds for partially offscreen elements", () => {
    const crop = computeCalibratedCropRect({ x: 900, y: 450, width: 300, height: 200 }, metrics, {
      width: 2000,
      height: 1000,
    });
    expect(crop).toEqual({ x: 1800, y: 900, width: 200, height: 100 });
  });

  it("returns null when the scale cannot be trusted", () => {
    expect(
      computeCalibratedCropRect({ x: 0, y: 0, width: 10, height: 10 }, metrics, {
        width: Number.NaN,
        height: 100,
      }),
    ).toBeNull();
  });
});

describe("captureElementScreenshot", () => {
  function makeFrame(size: { width: number; height: number }) {
    return {
      isEmpty: () => false,
      getSize: () => size,
      crop: (rect: { x: number; y: number; width: number; height: number }) =>
        makeFrameFromCrop(rect),
      toDataURL: () => "data:image/png;base64,full",
    };
  }
  function makeFrameFromCrop(rect: { x: number; y: number; width: number; height: number }) {
    return {
      isEmpty: () => false,
      getSize: () => ({ width: rect.width, height: rect.height }),
      crop: () => makeFrameFromCrop(rect),
      toDataURL: () => `data:image/png;base64,crop-${JSON.stringify(rect)}`,
    };
  }

  it("crops the full frame with calibrated coordinates and prefers the fresh rect", async () => {
    let executedCode = "";
    const contents = {
      executeJavaScript: async (code: string) => {
        executedCode = code;
        return JSON.stringify({
          viewportWidth: 1000,
          viewportHeight: 500,
          rect: { x: 10, y: 20, width: 30, height: 40 },
        });
      },
      capturePage: async (rect?: unknown) => {
        expect(rect).toBeUndefined();
        return makeFrame({ width: 2000, height: 1000 });
      },
    };
    const dataUrl = await captureElementScreenshot(contents as never, {
      rect: { x: 0, y: 0, width: 999, height: 999 },
      selector: "#target",
    });
    // Fresh rect wins over the stale requested rect, scaled by 2x.
    expect(dataUrl).toBe(
      `data:image/png;base64,crop-${JSON.stringify({ x: 20, y: 40, width: 60, height: 80 })}`,
    );
    expect(executedCode).toContain("#target");
  });

  it("falls back to the requested rect when guest measurement fails", async () => {
    const contents = {
      executeJavaScript: async () => {
        throw new Error("navigation in progress");
      },
      capturePage: async () => makeFrame({ width: 2000, height: 1000 }),
    };
    const dataUrl = await captureElementScreenshot(contents as never, {
      rect: { x: 10, y: 20, width: 30, height: 40 },
      selector: null,
    });
    // Without guest metrics there is no calibration, so the requested rect is
    // handed to capturePage untouched.
    expect(dataUrl).toBe("data:image/png;base64,full");
  });

  it("uses the legacy rect path when calibration is impossible", async () => {
    const captured: Array<unknown> = [];
    const contents = {
      executeJavaScript: async () => JSON.stringify({ viewportWidth: 0, viewportHeight: 0 }),
      capturePage: async (rect?: unknown) => {
        captured.push(rect);
        return {
          // Empty only for a no-arg full-frame call.
          isEmpty: () => rect === undefined,
          getSize: () => ({ width: 0, height: 0 }),
          crop: () => ({
            isEmpty: () => true,
            getSize: () => ({ width: 0, height: 0 }),
            crop: () => null,
            toDataURL: () => "",
          }),
          toDataURL: () => "data:image/png;base64,legacy",
        };
      },
    };
    const dataUrl = await captureElementScreenshot(contents as never, {
      rect: { x: 5, y: 5, width: 50, height: 50 },
      selector: null,
    });
    expect(captured).toEqual([{ x: 5, y: 5, width: 50, height: 50 }]);
    expect(dataUrl).toBe("data:image/png;base64,legacy");
  });
});
