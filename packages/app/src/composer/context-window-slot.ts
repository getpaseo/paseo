interface CompactContextWindowSlotInput {
  isCompactLayout: boolean;
  hasAgent: boolean;
}

export function shouldRenderCompactContextWindowSlot({
  isCompactLayout,
  hasAgent,
}: CompactContextWindowSlotInput): boolean {
  return isCompactLayout && hasAgent;
}
