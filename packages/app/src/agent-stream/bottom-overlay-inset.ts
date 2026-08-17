export function resolveBottomOverlayTailInset({
  overlayHeight,
  clearance,
  existingTailSpacing,
}: {
  overlayHeight: number;
  clearance: number;
  existingTailSpacing: number;
}): number {
  return Math.max(0, overlayHeight + clearance - existingTailSpacing);
}
