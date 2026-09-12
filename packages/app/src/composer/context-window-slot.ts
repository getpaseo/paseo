interface CompactContextWindowSlotInput {
  isCompactLayout: boolean;
  hasAgent: boolean;
  hasMeter: boolean;
  activeAgentKey: string;
  reservedAgentKey: string | null;
}

export function shouldRenderCompactContextWindowSlot({
  isCompactLayout,
  hasAgent,
  hasMeter,
  activeAgentKey,
  reservedAgentKey,
}: CompactContextWindowSlotInput): boolean {
  return isCompactLayout && hasAgent && (hasMeter || activeAgentKey === reservedAgentKey);
}
