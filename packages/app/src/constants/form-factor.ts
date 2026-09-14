// ---------------------------------------------------------------------------
// Device form factor, independent of layout.
//
// This answers "is this a large screen?" from the *device*, not the window.
// Layout breakpoints answer a different question — how wide is the current
// window — and must keep using window width. See constants/layout.ts.
// ---------------------------------------------------------------------------

/**
 * Android's large-screen baseline, `sw600dp`. Android 16 stops honoring an
 * app's fixed orientation on displays whose smallest width reaches this, but
 * older releases still confine the app to a portrait window and pillarbox it.
 *
 * https://developer.android.com/about/versions/16/behavior-changes-16
 */
export const LARGE_SCREEN_MIN_SHORTEST_SIDE = 600;

export type OrientationPolicy = "follow-sensor" | "lock-portrait";

/**
 * Orientation policy for the current device.
 *
 * Large screens are free to rotate; phones stay portrait. This matches what
 * Android 16 already does for large screens, and restores it on older releases
 * where the manifest's fixed `screenOrientation` is still enforced.
 *
 * iOS and web return `null`: iOS already gets this split from the Info.plist
 * keys Expo writes (the base key is portrait, `~ipad` is all four), so it needs
 * no runtime lock.
 *
 * The input is the physical screen, not the current window — a tablet in a
 * floating or split window is still a tablet for this decision.
 */
export function resolveOrientationPolicy(args: {
  isAndroid: boolean;
  screenWidth: number;
  screenHeight: number;
}): OrientationPolicy | null {
  if (!args.isAndroid) {
    return null;
  }

  const shortestSide = Math.min(args.screenWidth, args.screenHeight);

  return shortestSide >= LARGE_SCREEN_MIN_SHORTEST_SIDE ? "follow-sensor" : "lock-portrait";
}
