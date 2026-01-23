export type CheckoutStatusRevalidationParams = {
  serverId: string;
  agentId: string;
  isOpen: boolean;
  explorerTab: string;
};

export function checkoutStatusRevalidationKey(params: CheckoutStatusRevalidationParams): string | null {
  if (!params.agentId) return null;
  if (!params.isOpen) return null;
  if (params.explorerTab !== "changes") return null;
  return `${params.serverId}:${params.agentId}`;
}

export function nextCheckoutStatusRefetchDecision(
  prevKey: string | null,
  nextKey: string | null
): { nextSeenKey: string | null; shouldRefetch: boolean } {
  if (!nextKey) return { nextSeenKey: null, shouldRefetch: false };
  if (prevKey === nextKey) return { nextSeenKey: prevKey, shouldRefetch: false };
  return { nextSeenKey: nextKey, shouldRefetch: true };
}

