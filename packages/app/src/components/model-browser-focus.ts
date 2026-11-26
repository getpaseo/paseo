/** Native moves no focus to buttons from a hardware keyboard, so Enter always reaches the picker. */
export function focusedModelBrowserControlOwnsEnter(): boolean {
  return false;
}
