export interface KeyboardInputEnvironment {
  isNative: boolean;
  isCompact: boolean;
  isElectron: boolean;
}

export function desktopKeyboardAvailable(input: KeyboardInputEnvironment): boolean {
  // Electron window width changes layout, not the keyboard's interaction model.
  return !input.isNative && (input.isElectron || !input.isCompact);
}

export function mobilePanelGesturesAvailable(input: { isElectron: boolean }): boolean {
  return !input.isElectron;
}
