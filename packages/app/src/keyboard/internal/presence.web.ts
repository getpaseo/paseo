import { createHardwareKeyboardPresence } from "./hardware-presence";

export function createWebHardwareKeyboardPresence(
  pointer: MediaQueryList | null,
  events: Window | null,
) {
  let observedKeyboard = false;
  return createHardwareKeyboardPresence({
    read: () => observedKeyboard || pointer?.matches === true,
    watch(changed) {
      if (!events) return () => {};
      const onKeyDown = (event: KeyboardEvent) => {
        if (!(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) return;
        observedKeyboard = true;
        changed();
      };
      pointer?.addEventListener("change", changed);
      events.addEventListener("keydown", onKeyDown, true);
      return () => {
        pointer?.removeEventListener("change", changed);
        events.removeEventListener("keydown", onKeyDown, true);
      };
    },
  });
}
const events = typeof window === "undefined" ? null : window;
const pointer =
  events && typeof events.matchMedia === "function"
    ? events.matchMedia("(hover: hover) and (pointer: fine)")
    : null;
export const hardwareKeyboardPresence = createWebHardwareKeyboardPresence(pointer, events);
