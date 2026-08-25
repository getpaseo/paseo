export function shouldRenderCompactContextWindowSlot(
  isCompactLayout: boolean,
  hasAgent: boolean,
  hasMeter: boolean,
  activeAgentKey: string,
  reservedAgentKey: string | null,
): boolean {
  return isCompactLayout && hasAgent && (hasMeter || activeAgentKey === reservedAgentKey);
}
