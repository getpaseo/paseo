// ---------------------------------------------------------------------------
// Foldable / large-screen form-factor logic (pure, framework-free).
//
// Kept separate from constants/layout.ts so it can be unit-tested without
// pulling in Unistyles or platform modules. The hooks in layout.ts just wire
// window dimensions + breakpoint + platform into these functions.
// ---------------------------------------------------------------------------

/**
 * Usable-area shortest side (dp) at which we treat the device as a large-screen
 * form factor (tablet or an unfolded foldable/tri-fold).
 *
 * 600 == Android's `sw600dp` tablet baseline, matching Pilot Kit's
 * `device_utils.dart` (`shortestSide >= 600`). We compare the *shortest* side
 * (min of width/height) rather than the current width so the result is
 * orientation-insensitive and shrinks correctly under split-screen.
 *
 * Verified against Resizable AVD at real Huawei Mate XT densities.
 */
export const LARGE_SCREEN_MIN_SHORTEST_SIDE = 600;

/** Whether the usable-area shortest side reaches the large-screen threshold. */
export function isLargeScreenShortestSide(shortestSide: number): boolean {
  return shortestSide >= LARGE_SCREEN_MIN_SHORTEST_SIDE;
}

/**
 * Decide whether to use the compact (phone, single-pane) layout.
 *
 * - web/desktop: breakpoint (window width) only — existing behavior preserved.
 * - native: an unfolded foldable in a large-screen form factor uses the
 *   two-pane layout even when the window is narrow (portrait), so a phone
 *   stays compact while a tri-fold expands into tablet layout.
 */
export function computeIsCompactFormFactor(args: {
  compactBreakpoint: boolean;
  largeScreenForm: boolean;
  native: boolean;
}): boolean {
  return args.compactBreakpoint && !(args.native && args.largeScreenForm);
}
