export function resolveBottomOverlayTailInset({
  requiredTailClearance,
  existingTailSpacing,
}: {
  requiredTailClearance: number;
  existingTailSpacing: number;
}): number {
  return Math.max(0, requiredTailClearance - existingTailSpacing);
}

interface BottomOverlayClearanceProps {
  bottomOverlayTailClearance?: number;
  bottomOverlayControlClearance?: number;
}

/** Overlay geometry is render state: a late-mounted composer track must invalidate the stream. */
export function bottomOverlayClearancesEqual(
  left: BottomOverlayClearanceProps,
  right: BottomOverlayClearanceProps,
): boolean {
  return (
    left.bottomOverlayTailClearance === right.bottomOverlayTailClearance &&
    left.bottomOverlayControlClearance === right.bottomOverlayControlClearance
  );
}

export function shouldAnchorForBottomOverlayAppearance(input: {
  previousTailClearance: number;
  nextTailClearance: number;
  isFollowingOutput: boolean;
}): boolean {
  const { previousTailClearance, nextTailClearance, isFollowingOutput } = input;
  return isFollowingOutput && previousTailClearance <= 0 && nextTailClearance > 0;
}
