export interface BrowserCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GuestCaptureMetrics {
  viewportWidth: number;
  viewportHeight: number;
  freshRect: BrowserCaptureRect | null;
  measureError: string | null;
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

// The selector flow stamps data-paseo-capture-id on the clicked node so the
// re-measure below finds that exact element even if the DOM shifted; a bare
// positional or duplicate-id selector could resolve to a different node.
function buildGuestCaptureMetricsScript(selector: string | null, captureId: string | null): string {
  return `
    (function() {
      var out = { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, rect: null, error: null };
      var captureId = ${captureId === null ? "null" : JSON.stringify(captureId)};
      var selector = ${selector === null ? "null" : JSON.stringify(selector)};
      var el = null;
      try {
        if (captureId) {
          el = document.querySelector('[data-paseo-capture-id=' + JSON.stringify(captureId) + ']');
        }
        if (!el && selector) {
          el = document.querySelector(selector);
        }
      } catch (err) {
        out.error = String(err);
      }
      if (el && el.isConnected) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
      return JSON.stringify(out);
    })()
  `;
}

function parseGuestCaptureMetrics(value: unknown): GuestCaptureMetrics | null {
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
    measureError: typeof record.error === "string" && record.error ? record.error : null,
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
function computeCalibratedCropRect(
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

const CAPTURE_ATTEMPTS = 2;
const STABILITY_TOLERANCE_PX = 1;

function rectsStable(a: BrowserCaptureRect | null, b: BrowserCaptureRect | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    Math.abs(a.x - b.x) <= STABILITY_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= STABILITY_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= STABILITY_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= STABILITY_TOLERANCE_PX
  );
}

function metricsStable(a: GuestCaptureMetrics, b: GuestCaptureMetrics): boolean {
  return (
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    rectsStable(a.freshRect, b.freshRect)
  );
}

async function measureGuest(
  contents: CaptureContents,
  script: string,
  warn?: (error: string) => void,
): Promise<GuestCaptureMetrics | null> {
  let raw: unknown;
  try {
    raw = await contents.executeJavaScript(script);
  } catch (error) {
    warn?.(error instanceof Error ? error.message : String(error));
    return null;
  }
  const metrics = parseGuestCaptureMetrics(raw);
  if (!metrics) {
    warn?.("guest returned no usable capture metrics");
    return null;
  }
  if (metrics.measureError) {
    warn?.(metrics.measureError);
  }
  return metrics;
}

async function captureFullFrame(contents: CaptureContents): Promise<NativeImageLike | null> {
  try {
    return await contents.capturePage();
  } catch {
    return null;
  }
}

function cropFrame(
  frame: NativeImageLike,
  rect: BrowserCaptureRect,
  metrics: GuestCaptureMetrics,
): string | null {
  const crop = computeCalibratedCropRect(rect, metrics, frame.getSize());
  if (!crop) return null;
  const cropped = frame.crop(crop);
  return cropped && !cropped.isEmpty() ? cropped.toDataURL() : null;
}

// The mark belongs to the capture: removing it here, scoped to this capture's
// id, keeps a later selector session's sweep-free install from racing a
// still-pending re-measure for this selection.
function buildClearCaptureMarkScript(captureId: string): string {
  return `
    (function() {
      var el = document.querySelector('[data-paseo-capture-id=' + JSON.stringify(${JSON.stringify(
        captureId,
      )}) + ']');
      if (el) el.removeAttribute('data-paseo-capture-id');
    })()
  `;
}

export async function captureElementScreenshot(
  contents: CaptureContents,
  input: {
    rect: BrowserCaptureRect;
    selector: string | null;
    captureId?: string | null;
    warn?: (error: string) => void;
  },
): Promise<string | null> {
  const script = buildGuestCaptureMetricsScript(input.selector, input.captureId ?? null);
  try {
    let metrics: GuestCaptureMetrics | null = null;
    let pageMoving = false;

    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      const before = await measureGuest(contents, script, input.warn);
      if (!before) break;
      metrics = before;
      const frame = await captureFullFrame(contents);
      if (!frame || frame.isEmpty()) break;
      // The guest can scroll, resize, or navigate between measurement and
      // frame capture; only crop when the metrics taken around the frame
      // agree.
      const after = await measureGuest(contents, script, input.warn);
      if (!after) break;
      metrics = after;
      if (!metricsStable(before, after)) {
        pageMoving = true;
        continue;
      }
      pageMoving = false;
      const dataUrl = cropFrame(frame, after.freshRect ?? input.rect, after);
      if (dataUrl) return dataUrl;
      break;
    }

    // Never hand the CSS-pixel rect to capturePage: on a scaled or zoomed
    // display it crops the wrong region, which is the bug being fixed. A
    // calibrated crop of the freshest known rect is still safe, but only when
    // the page was not actively moving.
    if (!metrics || pageMoving) return null;
    const frame = await captureFullFrame(contents);
    if (!frame || frame.isEmpty()) return null;
    return cropFrame(frame, metrics.freshRect ?? input.rect, metrics);
  } finally {
    if (input.captureId) {
      try {
        await contents.executeJavaScript(buildClearCaptureMarkScript(input.captureId));
      } catch {
        // Best-effort cleanup; a stale mark is inert.
      }
    }
  }
}
