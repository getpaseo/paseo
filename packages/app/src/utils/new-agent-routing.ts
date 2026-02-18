import type { CheckoutStatusPayload } from "@/hooks/use-checkout-status-query";
import {
  buildHostAgentDraftRoute,
  parseHostAgentRouteFromPathname,
} from "@/utils/host-routes";

export function parseAgentKey(
  key: string | null | undefined
): { serverId: string; agentId: string } | null {
  if (!key) {
    return null;
  }
  const sep = key.lastIndexOf(":");
  if (sep <= 0 || sep >= key.length - 1) {
    return null;
  }
  const serverId = key.slice(0, sep).trim();
  const agentId = key.slice(sep + 1).trim();
  if (!serverId || !agentId) {
    return null;
  }
  return { serverId, agentId };
}

export function resolveSelectedAgentForNewAgent(input: {
  pathname: string;
  selectedAgentId?: string;
}): { serverId: string; agentId: string } | null {
  return (
    parseHostAgentRouteFromPathname(input.pathname) ??
    parseAgentKey(input.selectedAgentId)
  );
}

function inferMainRepoRootFromPaseoWorktreePath(cwd: string): string | null {
  const normalizedPath = cwd.replace(/\\/g, "/");
  const marker = "/.paseo/worktrees";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex <= 0) {
    return null;
  }
  const markerEnd = markerIndex + marker.length;
  const nextChar = normalizedPath[markerEnd];
  if (nextChar && nextChar !== "/") {
    return null;
  }
  const inferred = cwd.slice(0, markerIndex).replace(/[\\/]+$/, "");
  return inferred.trim() ? inferred : null;
}

export function resolveNewAgentWorkingDir(
  cwd: string,
  checkout: CheckoutStatusPayload | null
): string {
  const explicitMainRepoRoot = checkout?.isPaseoOwnedWorktree
    ? checkout.mainRepoRoot?.trim() || null
    : null;
  if (explicitMainRepoRoot) {
    return explicitMainRepoRoot;
  }

  return inferMainRepoRootFromPaseoWorktreePath(cwd) ?? cwd;
}

export function buildNewAgentRoute(
  serverId: string,
  workingDir?: string | null
): string {
  const baseRoute = buildHostAgentDraftRoute(serverId);
  if (baseRoute === "/") {
    return baseRoute;
  }
  const trimmedWorkingDir = workingDir?.trim();
  if (!trimmedWorkingDir) {
    return baseRoute;
  }
  return `${baseRoute}?workingDir=${encodeURIComponent(trimmedWorkingDir)}`;
}
