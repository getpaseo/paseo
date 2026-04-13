import type { BottomAnchorRouteRequest } from "@/components/use-bottom-anchor-controller";

export type RouteBottomAnchorIntent = {
  routeKey: string;
  reason: BottomAnchorRouteRequest["reason"];
};

export function deriveRouteBottomAnchorIntent(input: {
  cachedIntent: RouteBottomAnchorIntent | null;
  routeKey: string | null;
  hasAppliedAuthoritativeHistoryAtEntry: boolean;
}): RouteBottomAnchorIntent | null {
  if (!input.routeKey) {
    return null;
  }
  if (input.cachedIntent?.routeKey === input.routeKey) {
    return input.cachedIntent;
  }
  return {
    routeKey: input.routeKey,
    reason: input.hasAppliedAuthoritativeHistoryAtEntry ? "resume" : "initial-entry",
  };
}

export function deriveRouteBottomAnchorRequest(input: {
  intent: RouteBottomAnchorIntent | null;
  effectiveAgentId: string | null;
}): BottomAnchorRouteRequest | null {
  if (!input.intent || !input.effectiveAgentId) {
    return null;
  }
  return {
    reason: input.intent.reason,
    agentId: input.effectiveAgentId,
    requestKey: `${input.intent.routeKey}:${input.intent.reason}`,
  };
}
