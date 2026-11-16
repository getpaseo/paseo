/** Temporary diagnostics are Android-only. Metro selects index.android.ts on Android. */
export interface ComposerTouchState {
  active: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  focused: boolean;
  fullscreen: boolean;
  voiceOverlay: boolean;
}

export function recordComposerCommand(_command: "send" | "queue" | "control" | "model"): void {}
export function useComposerTouchDiagnostics(_state: ComposerTouchState) {
  return {};
}
