/** Native moves no focus to buttons from a hardware keyboard, so Enter always reaches the picker. */
export function focusedModelBrowserControlOwnsEnter(): boolean {
  return false;
}

/** Native fires focus on rows only for a hardware keyboard or a TV remote. */
export function focusCameFromKeyboard(_target: unknown): boolean {
  return true;
}
