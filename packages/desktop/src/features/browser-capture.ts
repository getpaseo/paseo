import {
  captureElementScreenshot,
  normalizeBrowserCaptureRect,
  type BrowserCaptureRect,
} from "./browser-webviews/capture-element.js";

export type { BrowserCaptureRect };

export interface BrowserCaptureImage {
  isEmpty(): boolean;
  toDataURL(): string;
  getSize(): { width: number; height: number };
  crop(rect: BrowserCaptureRect): BrowserCaptureImage;
}

export interface BrowserCaptureGuest<TImage extends BrowserCaptureImage = BrowserCaptureImage> {
  isDestroyed(): boolean;
  capturePage(rect?: BrowserCaptureRect): Promise<TImage>;
  executeJavaScript(code: string): Promise<unknown>;
}

interface BrowserCaptureClipboardPayload<TImage extends BrowserCaptureImage> {
  text: string | null;
  image: TImage | null;
}

interface BrowserCaptureClipboard<TImage extends BrowserCaptureImage> {
  write(input: BrowserCaptureClipboardPayload<TImage>): Promise<void>;
}

interface BrowserCaptureDependencies<TImage extends BrowserCaptureImage> {
  findGuest(browserId: string, hostWebContentsId: number): BrowserCaptureGuest<TImage> | null;
  decodeImage(dataUrl: string): TImage;
  clipboard: BrowserCaptureClipboard<TImage>;
  warn(
    event: "capture-failed" | "image-decode-failed" | "measure-failed",
    details: Record<string, unknown>,
  ): void;
}

export interface BrowserCaptureService {
  capture(input: {
    browserId: unknown;
    hostWebContentsId: number;
    rect: unknown;
    selector?: unknown;
    captureId?: unknown;
  }): Promise<string | null>;
  copy(payload: unknown): Promise<boolean>;
}

function copyPayload(value: unknown): { text: string | null; imageDataUrl: string | null } {
  if (!value || typeof value !== "object") return { text: null, imageDataUrl: null };
  const record = value as Record<string, unknown>;
  return {
    text: typeof record.text === "string" && record.text.length > 0 ? record.text : null,
    imageDataUrl:
      typeof record.imageDataUrl === "string" && record.imageDataUrl.startsWith("data:image")
        ? record.imageDataUrl
        : null,
  };
}

export function createBrowserCaptureService<TImage extends BrowserCaptureImage>(
  dependencies: BrowserCaptureDependencies<TImage>,
): BrowserCaptureService {
  return {
    async capture({ browserId, hostWebContentsId, rect, selector, captureId }) {
      if (typeof browserId !== "string" || browserId.trim().length === 0) return null;
      const guest = dependencies.findGuest(browserId, hostWebContentsId);
      const bounds = normalizeBrowserCaptureRect(rect);
      if (!guest || guest.isDestroyed() || !bounds) return null;
      const elementSelector = typeof selector === "string" && selector.trim() ? selector : null;
      const elementCaptureId = typeof captureId === "string" && captureId.trim() ? captureId : null;
      try {
        // capturePage(rect) crops in a different coordinate space than
        // getBoundingClientRect() whenever the display scale factor or page
        // zoom is not 1; captureElementScreenshot calibrates against the
        // guest viewport and never hands the CSS rect to capturePage.
        return await captureElementScreenshot(guest, {
          rect: bounds,
          selector: elementSelector,
          captureId: elementCaptureId,
          warn: (error) => dependencies.warn("measure-failed", { browserId, error }),
        });
      } catch (error) {
        dependencies.warn("capture-failed", { browserId, error });
        return null;
      }
    },

    async copy(payload) {
      const { text, imageDataUrl } = copyPayload(payload);
      let image: TImage | null = null;
      if (imageDataUrl) {
        try {
          const decoded = dependencies.decodeImage(imageDataUrl);
          if (!decoded.isEmpty()) image = decoded;
        } catch (error) {
          dependencies.warn("image-decode-failed", { error });
        }
      }
      if (!text && !image) return false;
      await dependencies.clipboard.write({ text, image });
      return true;
    },
  };
}
