import { SPACING } from "@/styles/theme";

export const ADD_PROJECT_PANEL_MAX_HEIGHT_RATIO = 0.8;

export interface AddProjectPanelMaxHeightInput {
  overlayHeight: number;
  keyboardShift: number;
  safeAreaBottom: number;
}

// Android already shrinks the window with the IME. iOS keeps the full frame.
export function resolveAddProjectKeyboardShift(platform: string, reserve: number): number {
  return platform === "ios" ? reserve : 0;
}

export function resolveAddProjectPanelMaxHeight(
  input: AddProjectPanelMaxHeightInput,
): number | null {
  if (input.overlayHeight <= 0) return null;
  const restingCap = input.overlayHeight * ADD_PROJECT_PANEL_MAX_HEIGHT_RATIO;
  // keyboardShift is the IME above the safe area, so the home indicator is reserved once.
  const available = input.overlayHeight - SPACING[12] - input.keyboardShift - input.safeAreaBottom;
  if (available >= restingCap) return null;
  return Math.max(0, available);
}
