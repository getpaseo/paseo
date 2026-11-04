import { useLayoutEffect } from "react";
import { focusSurfaces, type KeyboardFocusSurface } from "./focus-surfaces";
export function useKeyboardFocusSurface(surface: KeyboardFocusSurface, focused: boolean): void {
  useLayoutEffect(() => {
    if (focused) return focusSurfaces.declare(surface);
  }, [surface, focused]);
}
