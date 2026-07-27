export const DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT = 120;

export function resolveWebAbsoluteDeviceFixedOffset(input: {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportPageTop: number;
}): number {
  const { layoutViewportHeight, visualViewportHeight, visualViewportPageTop } = input;
  if (
    !Number.isFinite(layoutViewportHeight) ||
    !Number.isFinite(visualViewportHeight) ||
    !Number.isFinite(visualViewportPageTop)
  ) {
    return 0;
  }

  return visualViewportHeight - layoutViewportHeight + visualViewportPageTop;
}

export function resolveWebComposerDockFillDepth(input: {
  layoutViewportHeight: number;
  visualViewportHeight: number;
}): number {
  const { layoutViewportHeight, visualViewportHeight } = input;
  if (!Number.isFinite(layoutViewportHeight) || !Number.isFinite(visualViewportHeight)) {
    return 0;
  }
  return Math.max(0, layoutViewportHeight - visualViewportHeight);
}

export function resolveFloatingComposerBottom(input: {
  isWeb: boolean;
  isCompact: boolean;
  keyboardShift: number;
  bottomInset: number;
}): number {
  "worklet";
  if (!input.isCompact) {
    return 0;
  }
  if (input.isWeb) {
    return -input.bottomInset;
  }
  return input.keyboardShift === 0 ? -input.bottomInset : 0;
}

export function resolveKeyboardShift(input: {
  rawKeyboardHeight: number;
  keyboardProgress: number;
  bottomInset: number;
  isIos: boolean;
  iosMinHeight: number;
}): number {
  "worklet";

  if (!(input.keyboardProgress > 0) || !(input.rawKeyboardHeight > 0)) {
    return 0;
  }

  // iOS can report a small accessory/prediction bar height during touch focus.
  // Treat that as non-keyboard so layouts don't "bounce" while interacting.
  if (input.isIos && input.rawKeyboardHeight < input.iosMinHeight) {
    return 0;
  }

  return Math.max(0, input.rawKeyboardHeight - input.bottomInset);
}
