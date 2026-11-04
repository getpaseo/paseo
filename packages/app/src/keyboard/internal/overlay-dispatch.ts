import { overlays } from "./overlays";
export const dispatchTopOverlayKeyDown = overlays.dispatch;
export const hasActiveOverlay = overlays.hasActive;
export const getTopOverlayKeys = overlays.getKeys;
export const subscribeOverlays = overlays.subscribe;
export function getTopOverlayLayer(): number {
  return overlays.getTop()?.getLayer() ?? 0;
}
