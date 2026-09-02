/**
 * Pure Live Activity deep-link helpers. Wraps `buildAgentDeepLink` with the query parameters
 * from the fixed fleet-mode contract. Every link targets the current hero agent; tapping one
 * never submits a permission response by itself.
 */

import { buildAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

export interface LiveActivityPermissionReviewTarget extends AgentDeepLinkTarget {
  permissionRequestId: string;
}

export interface LiveActivityPermissionActionTarget extends LiveActivityPermissionReviewTarget {
  permissionActionId: string;
}

export interface LiveActivityDeepLinkParams {
  serverId: string;
  agentId: string;
  source: string | null;
  permissionRequestId: string | null;
  permissionActionId: string | null;
}

function appendLiveActivityQuery(
  base: string,
  extra: { permissionRequestId?: string; permissionActionId?: string },
): string {
  const query = new URLSearchParams();
  query.set("source", "live-activity");
  if (extra.permissionRequestId !== undefined) {
    query.set("permissionRequestId", extra.permissionRequestId);
  }
  if (extra.permissionActionId !== undefined) {
    query.set("permissionActionId", extra.permissionActionId);
  }
  return `${base}?${query.toString()}`;
}

/** The base hero link: opens the exact hero agent, no permission review attached. */
export function buildLiveActivityHeroDeepLink(target: AgentDeepLinkTarget): string {
  return appendLiveActivityQuery(buildAgentDeepLink(target), {});
}

/** Review link: opens the hero agent at the exact pending permission request. */
export function buildLiveActivityPermissionReviewDeepLink(
  target: LiveActivityPermissionReviewTarget,
): string {
  return appendLiveActivityQuery(buildAgentDeepLink(target), {
    permissionRequestId: target.permissionRequestId,
  });
}

/** Primary-action link: review params plus the provider action id to focus. */
export function buildLiveActivityPermissionPrimaryDeepLink(
  target: LiveActivityPermissionActionTarget,
): string {
  return appendLiveActivityQuery(buildAgentDeepLink(target), {
    permissionRequestId: target.permissionRequestId,
    permissionActionId: target.permissionActionId,
  });
}

/**
 * Parses a link built by the helpers above. Independent of `parseAgentDeepLink`, which rejects
 * any URL carrying a query string; this is the query-aware counterpart used for round-trip
 * verification and for reading the params off `paseo://` links directly.
 */
export function parseLiveActivityDeepLink(input: string): LiveActivityDeepLinkParams | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "paseo:" || url.hostname !== "h" || url.username || url.password) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[1] !== "agent") {
    return null;
  }

  let serverId: string;
  let agentId: string;
  try {
    serverId = decodeURIComponent(segments[0] ?? "").trim();
    agentId = decodeURIComponent(segments[2] ?? "").trim();
  } catch {
    return null;
  }
  if (!serverId || !agentId) {
    return null;
  }

  return {
    serverId,
    agentId,
    source: url.searchParams.get("source"),
    permissionRequestId: url.searchParams.get("permissionRequestId"),
    permissionActionId: url.searchParams.get("permissionActionId"),
  };
}
