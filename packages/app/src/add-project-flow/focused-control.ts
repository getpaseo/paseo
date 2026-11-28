/** Native moves no focus to buttons from a hardware keyboard, so Enter always reaches the sheet. */
export function focusedControlOwnsEnter(): boolean {
  return false;
}
