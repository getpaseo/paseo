import { hasFocusedTextInput } from "./focused-text-input";
import type { KeyboardFocusScope } from "../actions";
export type KeyboardFocusSurface = "message-input" | "terminal";

export function createKeyboardFocusScope(hasEditableFocus: () => boolean = () => false) {
  const surfaces = new Map<symbol, KeyboardFocusSurface>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    declare(surface: KeyboardFocusSurface) {
      const token = Symbol(surface);
      surfaces.set(token, surface);
      notify();
      return () => {
        if (surfaces.delete(token)) notify();
      };
    },
    /** Pass `editableFocused` to resolve for a text control that is not a declared surface. */
    resolve(commandCenterOpen: boolean, editableFocused = hasEditableFocus()): KeyboardFocusScope {
      if (commandCenterOpen) return "command-center";
      let focused: KeyboardFocusScope = editableFocused ? "editable" : "other";
      for (const surface of surfaces.values()) focused = surface;
      return focused;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export const focusSurfaces = createKeyboardFocusScope(hasFocusedTextInput);
