export { useOverlayRegistration } from "./internal/overlay-registration";
export type { KeyboardInputEvent } from "./internal/overlays";
export {
  dispatchTopOverlayKeyDown,
  hasActiveOverlay,
  getTopOverlayKeys,
  getTopOverlayLayer,
  subscribeOverlays,
} from "./internal/overlay-dispatch";
