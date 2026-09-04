import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { resolvePaseoWorktreePlacement } from "@/utils/paseo-worktree-path";
import {
  parseHostWorkspaceOpenIntentFromPathname,
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

export function parseAgentKey(
  key: string | null | undefined,
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
  const workspaceRoute = parseHostWorkspaceRouteFromPathname(input.pathname);
  const openIntent = parseHostWorkspaceOpenIntentFromPathname(input.pathname);
  if (workspaceRoute && openIntent?.kind === "agent") {
    const agentId = openIntent.agentId.trim();
    if (agentId) {
      return { serverId: workspaceRoute.serverId, agentId };
    }
  }
  return parseHostAgentRouteFromPathname(input.pathname) ?? parseAgentKey(input.selectedAgentId);
}

/**
 * Where a "new agent" started from `cwd` should actually run.
 *
 * A Paseo-managed worktree routes to the repo it was cut from. Only the daemon knows that
 * repo — `checkout.mainRepoRoot` is the answer. Under the current
 * `<worktreesRoot>/<hash>/<slug>` layout the path cannot substitute for it, so without a
 * checkout the caller stays in `cwd`.
 */
export function resolveNewAgentWorkingDir(
  cwd: string,
  checkout: CheckoutStatusPayload | null,
  options?: { worktreesRoot?: string | null },
): string {
  const explicitMainRepoRoot = checkout?.isPaseoOwnedWorktree
    ? checkout.mainRepoRoot?.trim() || null
    : null;
  if (explicitMainRepoRoot) {
    return explicitMainRepoRoot;
  }

  const inferred = resolvePaseoWorktreePlacement(cwd, options?.worktreesRoot)?.mainRepoRoot;
  return inferred?.trim() ? inferred : cwd;
}
