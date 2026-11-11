import { focusSurfaces } from "../focus-surfaces";
import { overlays } from "../overlays";
import { nativeKeyboardInput, type KeyboardSourceHandlers } from "./contract";
import type { HardwareKeyboardEvent } from "./hardware";
interface HardwareKeySource {
  subscribe(handler: (event: HardwareKeyboardEvent) => void): () => void;
  setOverlayKeys(keys: readonly string[]): void;
}
export function attachHardwareKeyboardSource(
  source: HardwareKeySource,
  handlers: KeyboardSourceHandlers,
): () => void {
  const updateKeys = () => source.setOverlayKeys(overlays.getKeys());
  updateKeys();
  const unsubscribeOverlays = overlays.subscribe(updateKeys);
  const unsubscribeHardware = source.subscribe((input) => {
    const event = { ...input, preventDefault() {}, stopPropagation() {} };
    if (input.phase === "up") {
      handlers.keyUp(event);
      return;
    }
    handlers.keyDown(
      nativeKeyboardInput(event, focusSurfaces.resolve(handlers.commandCenterOpen())),
    );
  });
  return () => {
    unsubscribeHardware();
    unsubscribeOverlays();
    source.setOverlayKeys([]);
  };
}
