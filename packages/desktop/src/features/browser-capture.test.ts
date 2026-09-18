import { describe, expect, it, vi } from "vitest";
import {
  createBrowserCaptureService,
  type BrowserCaptureGuest,
  type BrowserCaptureImage,
} from "./browser-capture.js";

function image(dataUrl = "data:image/png;base64,capture"): BrowserCaptureImage {
  return {
    isEmpty: () => false,
    toDataURL: () => dataUrl,
    getSize: () => ({ width: 100, height: 100 }),
    crop: () => image(dataUrl),
  };
}

function harness(guest: BrowserCaptureGuest | null = null) {
  const clipboard = { write: vi.fn(async () => undefined) };
  const decodeImage = vi.fn(() => image("data:image/png;base64,clipboard"));
  const warn = vi.fn();
  return {
    clipboard,
    decodeImage,
    warn,
    service: createBrowserCaptureService({
      findGuest: () => guest,
      decodeImage,
      clipboard,
      warn,
    }),
  };
}

describe("browser capture service", () => {
  it("validates and rounds guest-relative bounds before capture", async () => {
    const cropped = image("data:image/png;base64,cropped");
    const frame = {
      ...image(),
      getSize: () => ({ width: 100, height: 100 }),
      crop: vi.fn(() => cropped),
    };
    const capturePage = vi.fn(async () => frame);
    // Viewport matches the frame, so the normalized rect crops 1:1.
    const executeJavaScript = vi.fn(async () =>
      JSON.stringify({ viewportWidth: 100, viewportHeight: 100, rect: null }),
    );
    const { service } = harness({ isDestroyed: () => false, capturePage, executeJavaScript });

    await expect(
      service.capture({
        browserId: "browser-1",
        hostWebContentsId: 42,
        rect: { x: -2.4, y: 8.6, width: 20.2, height: 10.8 },
      }),
    ).resolves.toBe("data:image/png;base64,cropped");
    expect(frame.crop).toHaveBeenCalledWith({ x: 0, y: 9, width: 20, height: 11 });
  });

  it("crops the full guest frame when the guest reports viewport metrics", async () => {
    const cropped = image("data:image/png;base64,cropped");
    const frame = {
      ...image(),
      getSize: () => ({ width: 200, height: 100 }),
      crop: vi.fn(() => cropped),
    };
    const capturePage = vi.fn(async () => frame);
    const executeJavaScript = vi.fn(async () =>
      JSON.stringify({ viewportWidth: 100, viewportHeight: 100, rect: null }),
    );
    const { service } = harness({ isDestroyed: () => false, capturePage, executeJavaScript });

    await expect(
      service.capture({
        browserId: "browser-1",
        hostWebContentsId: 42,
        rect: { x: 10, y: 10, width: 20, height: 20 },
        selector: ".annotated",
        captureId: "cap-1",
      }),
    ).resolves.toBe("data:image/png;base64,cropped");
    expect(capturePage).toHaveBeenCalledWith();
    expect(frame.crop).toHaveBeenCalledWith({ x: 20, y: 10, width: 40, height: 20 });
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("data-paseo-capture-id"),
    );
  });

  it("reports guest measurement failures through warn", async () => {
    const capturePage = vi.fn(async () => image());
    const executeJavaScript = vi.fn(async () => {
      throw new Error("navigation in progress");
    });
    const { service, warn } = harness({
      isDestroyed: () => false,
      capturePage,
      executeJavaScript,
    });

    await expect(
      service.capture({
        browserId: "browser-1",
        hostWebContentsId: 42,
        rect: { x: 10, y: 10, width: 20, height: 20 },
      }),
    ).resolves.toBeNull();
    // No uncalibrated capture is attempted when the guest cannot be measured.
    expect(capturePage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("measure-failed", {
      browserId: "browser-1",
      error: "navigation in progress",
    });
  });

  it("rejects invalid or unavailable captures without touching the guest", async () => {
    const capturePage = vi.fn(async () => image());
    const { service } = harness({
      isDestroyed: () => false,
      capturePage,
      executeJavaScript: vi.fn(async () => undefined),
    });

    await expect(
      service.capture({ browserId: "browser-1", hostWebContentsId: 42, rect: { width: 0 } }),
    ).resolves.toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("writes text and a decoded image to the clipboard atomically", async () => {
    const { service, clipboard } = harness();
    await expect(
      service.copy({ text: "button", imageDataUrl: "data:image/png;base64,value" }),
    ).resolves.toBe(true);
    expect(clipboard.write).toHaveBeenCalledWith({
      text: "button",
      image: expect.any(Object),
    });
  });

  it("keeps text-only clipboard writes", async () => {
    const { service, clipboard } = harness();

    await expect(service.copy({ text: "button" })).resolves.toBe(true);
    expect(clipboard.write).toHaveBeenCalledWith({ text: "button", image: null });
  });
});
