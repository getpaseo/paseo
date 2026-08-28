export interface BrowserCaptureImage {
  isEmpty(): boolean;
  toDataURL(): string;
}

export interface BrowserCaptureGuest<TImage extends BrowserCaptureImage = BrowserCaptureImage> {
  isDestroyed(): boolean;
  capturePage(rect: BrowserCaptureRect): Promise<TImage>;
}

export interface BrowserCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserCaptureClipboard<TImage extends BrowserCaptureImage> {
  write(input: { text: string; image: TImage }): void;
  writeImage(image: TImage): void;
  writeText(text: string): void;
}

interface BrowserCaptureDependencies<TImage extends BrowserCaptureImage> {
  findGuest(browserId: string, hostWebContentsId: number): BrowserCaptureGuest<TImage> | null;
  decodeImage(dataUrl: string): TImage;
  clipboard: BrowserCaptureClipboard<TImage>;
  warn(event: "capture-failed" | "image-decode-failed", details: Record<string, unknown>): void;
}

export interface BrowserCaptureService {
  capture(input: {
    browserId: unknown;
    hostWebContentsId: number;
    rect: unknown;
  }): Promise<string | null>;
  copy(payload: unknown): boolean;
}

function captureRect(value: unknown): BrowserCaptureRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const coordinates = [record.x, record.y, record.width, record.height];
  if (
    !coordinates.every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    return null;
  }
  const [x, y, width, height] = coordinates as number[];
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
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
    async capture({ browserId, hostWebContentsId, rect }) {
      if (typeof browserId !== "string" || browserId.trim().length === 0) return null;
      const guest = dependencies.findGuest(browserId, hostWebContentsId);
      const bounds = captureRect(rect);
      if (!guest || guest.isDestroyed() || !bounds) return null;
      try {
        const image = await guest.capturePage(bounds);
        return image.isEmpty() ? null : image.toDataURL();
      } catch (error) {
        dependencies.warn("capture-failed", { browserId, error });
        return null;
      }
    },

    copy(payload) {
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
      if (text && image) dependencies.clipboard.write({ text, image });
      else if (image) dependencies.clipboard.writeImage(image);
      else if (text) dependencies.clipboard.writeText(text);
      else return false;
      return true;
    },
  };
}
