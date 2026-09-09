export interface SwitchInput {
  value: boolean;
  disabled: boolean;
  onValueChange?: (value: boolean) => void;
}

export interface SwitchKeyboardEvent {
  nativeEvent?: { code?: string; key?: string };
  preventDefault?: () => void;
}

export function pressSwitch(input: SwitchInput, event: { stopPropagation: () => void }): void {
  event.stopPropagation();
  if (!input.disabled) input.onValueChange?.(!input.value);
}

export function keyDownSwitch(input: SwitchInput, event: SwitchKeyboardEvent): void {
  const native = event.nativeEvent;
  if (native?.code !== "Space" && native?.key !== " ") return;
  // RN Web handles Enter itself, but ignores Space on role=switch.
  event.preventDefault?.();
  if (!input.disabled) input.onValueChange?.(!input.value);
}
