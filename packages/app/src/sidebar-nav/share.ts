/**
 * How much of the desktop sidebar's height the top navigation block may take before it scrolls.
 * The default is the 50% cap the block always had; dragging the divider below it stores a
 * smaller share in app settings.
 */
export const DEFAULT_SIDEBAR_NAV_SHARE = 0.5;
export const MIN_SIDEBAR_NAV_SHARE = 0.1;
export const MAX_SIDEBAR_NAV_SHARE = 0.5;

export function clampSidebarNavShare(share: number): number {
  return Math.min(MAX_SIDEBAR_NAV_SHARE, Math.max(MIN_SIDEBAR_NAV_SHARE, share));
}

/** A stored share that is not a finite number falls back to the default; others are clamped. */
export function parseSidebarNavShare(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SIDEBAR_NAV_SHARE;
  }
  return clampSidebarNavShare(value);
}
