import { useCallback, useRef, useState } from "react";
import {
  EMPTY_TERMINAL_KEY_MODIFIERS,
  type TerminalKeyModifierState,
} from "./terminal-key-dispatch";

export function useTerminalModifiers() {
  const [modifiers, setModifiers] = useState<TerminalKeyModifierState>(
    EMPTY_TERMINAL_KEY_MODIFIERS,
  );
  const currentRef = useRef<TerminalKeyModifierState>(EMPTY_TERMINAL_KEY_MODIFIERS);

  const readModifiers = useCallback(() => currentRef.current, []);

  const clearModifiers = useCallback(() => {
    currentRef.current = EMPTY_TERMINAL_KEY_MODIFIERS;
    setModifiers({ ...EMPTY_TERMINAL_KEY_MODIFIERS });
  }, []);

  const toggleModifier = useCallback((modifier: keyof TerminalKeyModifierState) => {
    const current = currentRef.current;
    const next = { ...current, [modifier]: !current[modifier] };
    currentRef.current = next;
    setModifiers(next);
  }, []);

  return {
    modifiers,
    readModifiers,
    clearModifiers,
    toggleModifier,
  };
}
