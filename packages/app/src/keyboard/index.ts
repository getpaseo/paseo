import { useRetainedPanelActive } from "@/components/retained-panel";
import { useOverlayRegistration as usePlatformOverlayRegistration } from "./internal/overlay-registration";
import type { OverlayRegistration } from "./internal/overlay-contract";

export function useOverlayRegistration(input: OverlayRegistration) {
  const active = useRetainedPanelActive();
  return usePlatformOverlayRegistration({ ...input, active: input.active && active });
}
export type { KeyboardInputEvent } from "./internal/overlays";
export {
  dispatchTopOverlayKeyDown,
  hasActiveOverlay,
  getTopOverlayKeys,
  getTopOverlayLayer,
  subscribeOverlays,
} from "./internal/overlay-dispatch";
export { useKeyboardFocusSurface } from "./internal/use-focus-surface";
export { subscribeHardwareKeyboard } from "./internal/sources/hardware";
export type { HardwareKeyboardEvent } from "./internal/sources/hardware";
export { usesDesktopBindings, supportsConfigurableComposerSendKeys } from "./internal/conventions";
export type { BrowserKeyboardPolicy } from "./internal/sources/electron-browser";
export { useHardwareKeyboardPresent } from "./availability";
