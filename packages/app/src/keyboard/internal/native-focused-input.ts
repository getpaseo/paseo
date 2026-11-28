const focusedNativeInputs = new Set<symbol>();

/**
 * Registers a focused native text editor that is not backed by React Native's `TextInput`
 * (such as Android's `PaseoTerminalInputView`). Returns a disposer to call on blur or unmount.
 */
export function registerFocusedTextInput(): () => void {
  const token = Symbol("native-text-input");
  focusedNativeInputs.add(token);
  return () => {
    focusedNativeInputs.delete(token);
  };
}

export function hasRegisteredFocusedTextInput(): boolean {
  return focusedNativeInputs.size > 0;
}
