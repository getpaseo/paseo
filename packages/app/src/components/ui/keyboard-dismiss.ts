import { useEffect } from "react";
import { Keyboard } from "react-native";

export function useDismissKeyboardOnOpen(isOpen: boolean, enabled = true) {
  useEffect(() => {
    if (!enabled || !isOpen) return;

    Keyboard.dismiss();
    const frame = requestAnimationFrame(() => Keyboard.dismiss());
    const timer = setTimeout(() => Keyboard.dismiss(), 150);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [enabled, isOpen]);
}
