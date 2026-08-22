export function resolveBottomOverlayTailInset({
  requiredTailClearance,
  existingTailSpacing,
}: {
  requiredTailClearance: number;
  existingTailSpacing: number;
}): number {
  return Math.max(0, requiredTailClearance - existingTailSpacing);
}
