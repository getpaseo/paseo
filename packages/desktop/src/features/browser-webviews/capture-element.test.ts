import { describe, expect, it, vi } from "vitest";
import {
  captureElementScreenshot,
  normalizeBrowserCaptureRect,
  type BrowserCaptureRect,
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

function metricsJson(input: {
  viewportWidth: number;
  viewportHeight: number;
  rect?: { x: number; y: number; width: number; height: number } | null;
  error?: string | null;
}): string {
  return JSON.stringify({ rect: null, error: null, ...input });
}

function makeGuest(options: {
  measures?: Array<string | Error>;
  frameSize?: { width: number; height: number };
}) {
  const measures = [...(options.measures ?? [])];
  const frameSize = options.frameSize ?? { width: 2000, height: 1000 };
  const scripts: string[] = [];
  const captureArgs: Array<BrowserCaptureRect | undefined> = [];
  const crops: BrowserCaptureRect[] = [];
  const contents = {
    executeJavaScript: vi.fn(async (code: string) => {
      scripts.push(code);
      const next = measures.length > 1 ? measures.shift() : measures[0];
      if (next instanceof Error) {
        throw next;
      }
      return next ?? null;
    }),
    capturePage: vi.fn(async (rect?: BrowserCaptureRect) => {
      captureArgs.push(rect);
      if (rect === undefined) {
        return {
          isEmpty: () => false,
          getSize: () => frameSize,
          crop: (crop: BrowserCaptureRect) => {
            crops.push(crop);
            return {
              isEmpty: () => false,
              getSize: () => ({ width: crop.width, height: crop.height }),
              crop: () => null,
              toDataURL: () => "data:image/png;base64,cropped",
            };
          },
          toDataURL: () => "data:image/png;base64,full",
        };
      }
      return {
        isEmpty: () => false,
        getSize: () => ({ width: rect.width, height: rect.height }),
        crop: () => null,
        toDataURL: () => "data:image/png;base64,legacy",
      };
    }),
  };
  return { contents, scripts, captureArgs, crops };
}

const INPUT_RECT = { x: 10, y: 20, width: 30, height: 40 };

describe("captureElementScreenshot", () => {
  it("crops the full frame with calibrated coordinates and prefers the fresh rect", async () => {
    const guest = makeGuest({
      measures: [
        metricsJson({
          viewportWidth: 1000,
          viewportHeight: 500,
          rect: { x: 10, y: 20, width: 30, height: 40 },
        }),
      ],
    });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: { x: 0, y: 0, width: 999, height: 999 },
      selector: "#target",
    });
    // Fresh rect wins over the stale requested rect, scaled by the 2x frame.
    expect(dataUrl).toBe("data:image/png;base64,cropped");
    expect(guest.crops).toEqual([{ x: 20, y: 40, width: 60, height: 80 }]);
    expect(guest.captureArgs[0]).toBeUndefined();
    expect(guest.scripts[0]).toContain("#target");
  });

  it("calibrates for page zoom on top of the device scale factor", async () => {
    const guest = makeGuest({
      measures: [metricsJson({ viewportWidth: 800, viewportHeight: 500 })],
      frameSize: { width: 1250, height: 781.25 },
    });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: { x: 80, y: 64, width: 160, height: 96 },
      selector: null,
    });
    // Effective scale 1.5625 on both axes.
    expect(dataUrl).toBe("data:image/png;base64,cropped");
    expect(guest.crops).toEqual([{ x: 125, y: 100, width: 250, height: 150 }]);
  });

  it("clamps the crop to the frame for partially offscreen elements", async () => {
    const guest = makeGuest({
      measures: [
        metricsJson({
          viewportWidth: 1000,
          viewportHeight: 500,
          rect: { x: 900, y: 450, width: 300, height: 200 },
        }),
      ],
    });
    await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "#edge",
    });
    expect(guest.crops).toEqual([{ x: 1800, y: 900, width: 200, height: 100 }]);
  });

  it("queries the element by its capture marker before the selector", async () => {
    const guest = makeGuest({
      measures: [metricsJson({ viewportWidth: 1000, viewportHeight: 500 })],
    });
    await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "div:nth-of-type(2)",
      captureId: "cap-9",
    });
    expect(guest.scripts[0]).toContain("data-paseo-capture-id");
    expect(guest.scripts[0]).toContain('"cap-9"');
    expect(guest.scripts[0]).toContain("div:nth-of-type(2)");
    // The capture removes its own mark when it finishes.
    expect(guest.scripts.at(-1)).toContain("removeAttribute");
  });

  it("re-measures and recaptures when the page moves during capture", async () => {
    const moved = metricsJson({
      viewportWidth: 1000,
      viewportHeight: 500,
      rect: { x: 50, y: 60, width: 30, height: 40 },
    });
    const guest = makeGuest({
      measures: [
        metricsJson({
          viewportWidth: 1000,
          viewportHeight: 500,
          rect: { x: 10, y: 20, width: 30, height: 40 },
        }),
        moved,
      ],
    });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "#target",
    });
    expect(dataUrl).toBe("data:image/png;base64,cropped");
    // First attempt diverged, second attempt agreed: two full-frame captures.
    expect(guest.captureArgs).toEqual([undefined, undefined]);
    expect(guest.crops).toEqual([{ x: 100, y: 120, width: 60, height: 80 }]);
  });

  it("returns null when the page never sits still", async () => {
    const a = metricsJson({
      viewportWidth: 1000,
      viewportHeight: 500,
      rect: { x: 10, y: 20, width: 30, height: 40 },
    });
    const b = metricsJson({
      viewportWidth: 1000,
      viewportHeight: 500,
      rect: { x: 90, y: 90, width: 30, height: 40 },
    });
    const guest = makeGuest({ measures: [a, b, a, b] });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "#target",
    });
    // Both attempts diverged: any rect could land on unrelated content.
    expect(dataUrl).toBeNull();
    expect(guest.captureArgs).toEqual([undefined, undefined]);
    expect(guest.crops).toEqual([]);
  });

  it("warns and returns null when guest measurement fails", async () => {
    const warn = vi.fn();
    const guest = makeGuest({ measures: [new Error("navigation in progress")] });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "#target",
      warn,
    });
    // Without viewport metrics no crop can be trusted, and a misleading
    // screenshot is worse than none.
    expect(dataUrl).toBeNull();
    expect(guest.captureArgs).toEqual([]);
    expect(warn).toHaveBeenCalledWith("navigation in progress");
  });

  it("warns and returns null when the guest returns unusable metrics", async () => {
    const warn = vi.fn();
    const guest = makeGuest({ measures: ["not json"] });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: null,
      warn,
    });
    expect(dataUrl).toBeNull();
    expect(warn).toHaveBeenCalledWith("guest returned no usable capture metrics");
  });

  it("reports in-page selector errors but still captures", async () => {
    const warn = vi.fn();
    const guest = makeGuest({
      measures: [
        metricsJson({
          viewportWidth: 1000,
          viewportHeight: 500,
          error: "SyntaxError: '#[' is not a valid selector",
        }),
      ],
    });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: "#[",
      warn,
    });
    // No fresh rect, so the requested rect is calibrated and cropped.
    expect(dataUrl).toBe("data:image/png;base64,cropped");
    expect(guest.crops).toEqual([{ x: 20, y: 40, width: 60, height: 80 }]);
    expect(warn).toHaveBeenCalledWith("SyntaxError: '#[' is not a valid selector");
  });

  it("returns null when the captured frame size cannot be trusted", async () => {
    const guest = makeGuest({
      measures: [metricsJson({ viewportWidth: 1000, viewportHeight: 500 })],
      frameSize: { width: Number.NaN, height: 100 },
    });
    const dataUrl = await captureElementScreenshot(guest.contents as never, {
      rect: INPUT_RECT,
      selector: null,
    });
    expect(dataUrl).toBeNull();
    expect(guest.captureArgs).toEqual([undefined, undefined]);
  });
});
