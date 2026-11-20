import { resolveKeyboardFocusScope } from "../../focus-scope";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { keyBelongsToDomPopover } from "../dom-popover";
import type { KeyboardSourceHandlers } from "./contract";
export function attachDomKeyboardSource(handlers: KeyboardSourceHandlers): () => void {
  const down = (event: KeyboardEvent) => {
    if (document.visibilityState !== "visible" || keyBelongsToDomPopover(event)) return;
    handlers.keyDown({
      event: {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing || event.keyCode === 229,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopImmediatePropagation(),
      },
      focusScope: resolveKeyboardFocusScope({
        target: event.target,
        commandCenterOpen: handlers.commandCenterOpen(),
      }),
      captureFocusRestore() {
        const target = event.target instanceof Element ? event.target : null;
        const editable = target?.closest("textarea, input, [contenteditable='true']");
        const focused = editable instanceof HTMLElement ? editable : document.activeElement;
        setCommandCenterFocusRestoreElement(focused instanceof HTMLElement ? focused : null);
      },
    });
  };
  const up = (event: KeyboardEvent) => handlers.keyUp(event);
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("blur", handlers.blur);
  document.addEventListener("visibilitychange", handlers.blur);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("blur", handlers.blur);
    document.removeEventListener("visibilitychange", handlers.blur);
  };
}
