export interface BrowserCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuestCaptureMetrics {
  viewportWidth: number;
  viewportHeight: number;
  freshRect: BrowserCaptureRect | null;
}

interface CaptureContents {
  capturePage: (rect?: BrowserCaptureRect) => Promise<NativeImageLike>;
  executeJavaScript: (code: string) => Promise<unknown>;
}

// Deliberately shaped like Electron's NativeImage so tests can stub it without
// loading electron.
interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: BrowserCaptureRect): NativeImageLike;
  toDataURL(): string;
}

export function normalizeBrowserCaptureRect(rect: unknown): BrowserCaptureRect | null {
  if (!rect || typeof rect !== "object") {
    return null;
  }
  const candidate = rect as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function buildGuestCaptureMetricsScript(selector: string | null): string {
  return `
    (function() {
      var out = { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, rect: null };
      var selector = ${selector === null ? "null" : JSON.stringify(selector)};
      if (selector) {
        try {
          var el = document.querySelector(selector);
          if (el && el.isConnected) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              out.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
            }
          }
        } catch (err) {}
      }
      return JSON.stringify(out);
    })()
  `;
}

export function parseGuestCaptureMetrics(value: unknown): GuestCaptureMetrics | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const viewportWidth = record.viewportWidth;
  const viewportHeight = record.viewportHeight;
  if (
    typeof viewportWidth !== "number" ||
    typeof viewportHeight !== "number" ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth < 1 ||
    viewportHeight < 1
  ) {
    return null;
  }
  return {
    viewportWidth,
    viewportHeight,
    freshRect: normalizeBrowserCaptureRect(record.rect),
  };
}

function clampCropRect(
  rect: BrowserCaptureRect,
  bounds: { width: number; height: number },
): BrowserCaptureRect | null {
  const x = Math.min(Math.max(0, Math.round(rect.x)), bounds.width - 1);
  const y = Math.min(Math.max(0, Math.round(rect.y)), bounds.height - 1);
  const width = Math.min(Math.max(1, Math.round(rect.width)), bounds.width - x);
  const height = Math.min(Math.max(1, Math.round(rect.height)), bounds.height - y);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

// Maps a CSS-pixel element rect onto the captured frame. capturePage returns
// device-scaled pixels while getBoundingClientRect() is CSS pixels, and page
// zoom multiplies the two by another factor. Deriving the scale from the
// actual frame size versus the guest viewport keeps the crop correct on every
// display scale factor and zoom level.
export function computeCalibratedCropRect(
  rect: BrowserCaptureRect,
  metrics: GuestCaptureMetrics,
  frameSize: { width: number; height: number },
): BrowserCaptureRect | null {
  const scaleX = frameSize.width / metrics.viewportWidth;
  const scaleY = frameSize.height / metrics.viewportHeight;
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0 ||
    scaleX > 16 ||
    scaleY > 16
  ) {
    return null;
  }
  return clampCropRect(
    {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    },
    frameSize,
  );
}

export async function captureElementScreenshot(
  contents: CaptureContents,
  input: { rect: BrowserCaptureRect; selector: string | null },
): Promise<string | null> {
  // Re-measure the element in the guest at capture time so a scroll or layout
  // shift between click and capture cannot move the region off the element.
  let metrics: GuestCaptureMetrics | null = null;
  try {
    metrics = parseGuestCaptureMetrics(
      await contents.executeJavaScript(buildGuestCaptureMetricsScript(input.selector)),
    );
  } catch {
    metrics = null;
  }

  // A stale rect is still better than nothing when the guest cannot be measured.
  const rect = metrics?.freshRect ?? input.rect;

  if (metrics) {
    try {
      const frame = await contents.capturePage();
      const crop = frame.isEmpty()
        ? null
        : computeCalibratedCropRect(rect, metrics, frame.getSize());
      const croppedFrame = crop ? frame.crop(crop) : null;
      if (croppedFrame && !croppedFrame.isEmpty()) {
        return croppedFrame.toDataURL();
      }
    } catch {
      // Fall through to the legacy path below.
    }
  }

  try {
    const image = await contents.capturePage(rect);
    if (image.isEmpty()) {
      return null;
    }
    return image.toDataURL();
  } catch {
    return null;
  }
}
