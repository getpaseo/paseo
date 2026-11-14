/** A surface whose text size a pinch can change, independently of the others. */
export type TextZoomSurface = "chat" | "terminal" | "files";

export const TEXT_ZOOM_SURFACES: readonly TextZoomSurface[] = ["chat", "terminal", "files"];

/** Multipliers on the Appearance settings: 1 shows the settings' size. */
export type TextZoomState = Readonly<Record<TextZoomSurface, number>>;

export const DEFAULT_TEXT_ZOOM = 1;
export const MIN_TEXT_ZOOM = 0.5;
export const MAX_TEXT_ZOOM = 3;
const TEXT_ZOOM_STEPS_PER_UNIT = 20;
// One notch of a mouse wheel reports about 100; a trackpad pinch reports a few per event.
const WHEEL_ZOOM_PER_DELTA = 0.01;

export const DEFAULT_TEXT_ZOOM_STATE: TextZoomState = { chat: 1, terminal: 1, files: 1 };

export function isTextZoomSurface(value: unknown): value is TextZoomSurface {
  return value === "chat" || value === "terminal" || value === "files";
}

/** Clamps to the supported range and snaps to 5% steps, so sizes land on whole pixels more often. */
export function clampTextZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_TEXT_ZOOM;
  const clamped = Math.min(MAX_TEXT_ZOOM, Math.max(MIN_TEXT_ZOOM, zoom));
  // Dividing keeps decimals exact: 23 / 20 is 1.15, while 23 * 0.05 is 1.1500000000000001.
  return Math.round(clamped * TEXT_ZOOM_STEPS_PER_UNIT) / TEXT_ZOOM_STEPS_PER_UNIT;
}

/** The zoom a pinch reaches: the zoom it started at times the fingers' scale. */
export function pinchTextZoom(startZoom: number, gestureScale: number): number {
  return clampTextZoom(startZoom * gestureScale);
}

/**
 * Browsers report a trackpad pinch as a ctrl+wheel event. Wheel deltas accumulate exponentially,
 * so pinching out and back in by the same amount returns to the same size. Not snapped: a
 * trackpad sends many small deltas that would each round away.
 */
export function wheelTextZoom(zoom: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return zoom;
  return Math.min(
    MAX_TEXT_ZOOM,
    Math.max(MIN_TEXT_ZOOM, zoom * Math.exp(-deltaY * WHEEL_ZOOM_PER_DELTA)),
  );
}

/** The font size a surface draws at. Whole pixels keep terminal cells and line heights crisp. */
export function zoomedFontSize(fontSize: number, zoom: number): number {
  return Math.max(1, Math.round(fontSize * zoom));
}

export function formatTextZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Reads the saved zooms. Anything unreadable falls back to the default for that surface. */
export function parseStoredTextZoom(raw: string | null): TextZoomState {
  if (!raw) return DEFAULT_TEXT_ZOOM_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_TEXT_ZOOM_STATE;
  }
  if (parsed === null || typeof parsed !== "object") return DEFAULT_TEXT_ZOOM_STATE;
  const read = (surface: TextZoomSurface): number => {
    const value: unknown = Reflect.get(parsed, surface);
    return typeof value === "number" ? clampTextZoom(value) : DEFAULT_TEXT_ZOOM;
  };
  return { chat: read("chat"), terminal: read("terminal"), files: read("files") };
}
