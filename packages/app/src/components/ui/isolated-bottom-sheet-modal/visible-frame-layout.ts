export interface BottomSheetVisibleContentHeightInput {
  containerHeight: number;
  contentPosition: number;
  lowestDetentPosition?: number;
  handleHeight: number;
  keyboardHeight: number;
  isKeyboardVisible: boolean;
}

export interface BottomSheetSafeAreaPaddingInput {
  keyboardHeight: number;
  isKeyboardVisible: boolean;
  safeAreaBottom: number;
}

/**
 * Effective keyboard height inside the sheet container.
 *
 * Gorhom retains `heightWithinContainer` after the keyboard hides, and on first show `status`
 * flips to `SHOWN` before its reaction writes `heightWithinContainer`. Treating both states as 0
 * keeps frame height and safe-area clearance in lockstep.
 */
export function getBottomSheetEffectiveKeyboardHeight(
  keyboardHeight: number,
  isKeyboardVisible: boolean,
): number {
  "worklet";
  if (!isKeyboardVisible || keyboardHeight <= 0) return 0;
  return keyboardHeight;
}

export function getBottomSheetVisibleContentHeight({
  containerHeight,
  contentPosition,
  lowestDetentPosition,
  handleHeight,
  keyboardHeight,
  isKeyboardVisible,
}: BottomSheetVisibleContentHeightInput): number {
  "worklet";
  if (containerHeight < 0 || handleHeight < 0) return 0;
  const position = Math.min(contentPosition, lowestDetentPosition ?? contentPosition);
  const effectiveKeyboardHeight = getBottomSheetEffectiveKeyboardHeight(
    keyboardHeight,
    isKeyboardVisible,
  );
  return Math.max(0, containerHeight - position - handleHeight - effectiveKeyboardHeight);
}

/**
 * Bottom safe-area clearance derived from the same keyboard inset subtracted from
 * `SheetVisibleFrame`'s height so both update in one UI-thread commit.
 *
 * Invariant: `effectiveKeyboardHeight + paddingBottom >= safeAreaBottom`.
 */
export function getBottomSheetSafeAreaPaddingBottom({
  keyboardHeight,
  isKeyboardVisible,
  safeAreaBottom,
}: BottomSheetSafeAreaPaddingInput): number {
  "worklet";
  if (safeAreaBottom <= 0) return 0;
  const effectiveKeyboardHeight = getBottomSheetEffectiveKeyboardHeight(
    keyboardHeight,
    isKeyboardVisible,
  );
  return Math.max(0, safeAreaBottom - effectiveKeyboardHeight);
}
