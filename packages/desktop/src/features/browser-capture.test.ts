import { describe, expect, it, vi } from "vitest";
import {
  createBrowserCaptureService,
  type BrowserCaptureGuest,
  type BrowserCaptureImage,
} from "./browser-capture.js";

function image(dataUrl = "data:image/png;base64,capture"): BrowserCaptureImage {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
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
    const capturePage = vi.fn(async () => image());
    const { service } = harness({ isDestroyed: () => false, capturePage });

    await expect(
      service.capture({
        browserId: "browser-1",
        hostWebContentsId: 42,
        rect: { x: -2.4, y: 8.6, width: 20.2, height: 10.8 },
      }),
    ).resolves.toBe("data:image/png;base64,capture");
    expect(capturePage).toHaveBeenCalledWith({ x: 0, y: 9, width: 20, height: 11 });
  });

  it("rejects invalid or unavailable captures without touching the guest", async () => {
    const capturePage = vi.fn(async () => image());
    const { service } = harness({ isDestroyed: () => false, capturePage });

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
