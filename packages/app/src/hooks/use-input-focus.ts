import { useEffect, type RefObject } from "react";
import { focusWithRetries } from "@/utils/focus-with-retries";

interface FocusableInput {
  focus(): void;
  isFocused(): boolean;
}

export function useInputFocus(ref: RefObject<FocusableInput | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return focusWithRetries({
      focus: () => ref.current?.focus(),
      isFocused: () => ref.current?.isFocused() ?? false,
    });
  }, [active, ref]);
}
