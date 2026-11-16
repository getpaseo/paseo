import { MIN_MOBILE_SIDEBAR_WIDTH } from "@/stores/panel-store";

/** Within this distance of the window edge, a resize settles on "fill the window". */
const MOBILE_SIDEBAR_FULL_SNAP = 24;

/** `requestedWidth` null means the sidebar fills the window. */
export function resolveMobileSidebarWidth(input: {
  requestedWidth: number | null;
  windowWidth: number;
}): number {
  "worklet";
  if (input.requestedWidth === null) return input.windowWidth;
  const minimum = Math.min(MIN_MOBILE_SIDEBAR_WIDTH, input.windowWidth);
  return Math.max(minimum, Math.min(input.windowWidth, input.requestedWidth));
}

/** Worklet so the compact resize gesture can snap the shared width on release. */
export function resolveMobileSidebarPersistedWidth(input: {
  width: number;
  windowWidth: number;
}): number | null {
  "worklet";
  return input.width >= input.windowWidth - MOBILE_SIDEBAR_FULL_SNAP ? null : input.width;
}
