import { hasFocusedTextInput } from "./focused-text-input";
import type { KeyboardFocusScope } from "../actions";
export type KeyboardFocusSurface = "message-input" | "terminal";

export function createKeyboardFocusScope(hasEditableFocus: () => boolean = () => false) {
  const surfaces = new Map<symbol, KeyboardFocusSurface>();
  return {
    declare(surface: KeyboardFocusSurface) {
      const token = Symbol(surface);
      surfaces.set(token, surface);
      return () => {
        surfaces.delete(token);
      };
    },
    resolve(commandCenterOpen: boolean): KeyboardFocusScope {
      if (commandCenterOpen) return "command-center";
      let focused: KeyboardFocusScope = hasEditableFocus() ? "editable" : "other";
      for (const surface of surfaces.values()) focused = surface;
      return focused;
    },
  };
}
export const focusSurfaces = createKeyboardFocusScope(hasFocusedTextInput);
