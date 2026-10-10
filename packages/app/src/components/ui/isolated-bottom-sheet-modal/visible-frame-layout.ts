interface BottomSheetVisibleContentHeightInput {
  containerHeight: number;
  contentPosition: number;
  lowestDetentPosition?: number;
  handleHeight: number;
  keyboardHeight: number;
  isKeyboardVisible: boolean;
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
  return Math.max(
    0,
    containerHeight - position - handleHeight - (isKeyboardVisible ? keyboardHeight : 0),
  );
}
