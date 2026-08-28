import type { PaneSize } from "./viewport";

export interface BrowserScreencastView {
  uri: string | null;
  deviceWidth: number;
  deviceHeight: number;
  error: string | null;
}

export const EMPTY_SCREENCAST_VIEW: BrowserScreencastView = {
  uri: null,
  deviceWidth: 0,
  deviceHeight: 0,
  error: null,
};

export interface ScreencastSize {
  maxWidth: number;
  maxHeight: number;
}

// Every distinct size the pane reports re-arms the host capture, so the request
// climbs in steps: a drag across a whole step costs one re-arm, not one a pixel.
const SIZE_STEP = 320;

// The host encodes a JPEG of this many pixels per frame and the viewer decodes
// it, which is what a keystroke waits on. A retina pane asks for four times the
// pixels it has, so cap the budget rather than the device ratio.
const MAX_PIXELS = 4_000_000;

/** The displayed frame plus the one behind it, which may still be decoding. */
const FRAME_RETENTION = 2;

/**
 * Null until the pane can say how many pixels it can show. A zero-sized first
 * layout would subscribe at the floor and re-arm the host the moment the real
 * size lands, costing a stop and start per mount.
 */
export function screencastSize(pane: PaneSize | null, pixelRatio: number): ScreencastSize | null {
  if (pane === null || pane.width <= 0 || pane.height <= 0) return null;
  const width = pane.width * pixelRatio;
  const height = pane.height * pixelRatio;
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const quantise = (pixels: number) => Math.max(1, Math.round(pixels / SIZE_STEP)) * SIZE_STEP;
  return { maxWidth: quantise(width * scale), maxHeight: quantise(height * scale) };
}

export function sameScreencastSize(
  left: ScreencastSize | null,
  right: ScreencastSize | null,
): boolean {
  return left?.maxWidth === right?.maxWidth && left?.maxHeight === right?.maxHeight;
}

/**
 * Whether a stream that was `wasActive` and is now `active` needs a new
 * subscribe, an unsubscribe, or nothing. Both edges that reach here start out
 * unknown or already settled and must stay quiet:
 *
 * - Connection. A daemon that restarted has forgotten every stream and a socket
 *   that dropped took the subscription with it, so a reconnect has to
 *   re-subscribe or the pane sits on "connecting" until something remounts it.
 *   The client replays the current status on subscribe; taking that first
 *   replay (`wasActive === null`) as a reconnect would make every mount
 *   subscribe twice, which re-arms the host.
 * - Visibility, with `unsubscribeWhenInactive`. A pane the deck keeps mounted
 *   but off screen would otherwise hold a capture open on the host for pixels
 *   nobody sees. Re-subscribing redraws immediately because the daemon replays
 *   the last frame.
 */
export function subscriptionChange(
  wasActive: boolean | null,
  active: boolean,
  size: ScreencastSize | null,
  unsubscribeWhenInactive = false,
): ScreencastSize | "unsubscribe" | undefined {
  if (wasActive === null || wasActive === active) return;
  if (active) return size ?? undefined;
  return unsubscribeWhenInactive ? "unsubscribe" : undefined;
}

/** A subscribe that lost the race to a newer one must not paint its refusal. */
export function subscriptionErrorView(
  error: string | null,
  token: number,
  currentToken: number,
): BrowserScreencastView | undefined {
  return error !== null && token === currentToken ? { ...EMPTY_SCREENCAST_VIEW, error } : undefined;
}

/**
 * The frames to keep, then the ones to release. Revoking the source the `<img>`
 * is still decoding paints a broken image, and the swap is a render behind the
 * frame arriving, so keep one frame of slack.
 */
export function retainFrame<T>(frames: readonly T[], frame: T): readonly [T[], T[]] {
  const next = [...frames, frame];
  return [next.slice(-FRAME_RETENTION), next.slice(0, -FRAME_RETENTION)];
}
