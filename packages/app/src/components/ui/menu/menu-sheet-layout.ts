export function getMenuSheetBottomPadding(input: {
  safeAreaBottom: number;
  breathingRoom: number;
}): number {
  return input.safeAreaBottom + input.breathingRoom;
}
