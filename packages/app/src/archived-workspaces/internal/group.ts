import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export interface ArchivedWorkspaceAgent {
  id: string;
  title: string | null;
  provider: string;
}

/** A workspace the user archived, as agent history describes it. */
export interface ArchivedWorkspace {
  /** `serverId:workspaceId` */
  key: string;
  serverId: string;
  workspaceId: string;
  name: string;
  projectName: string | null;
  /** The host's project ID. */
  projectKey: string | null;
  branch: string | null;
  /** The latest archive time among its agents. */
  archivedAt: Date;
  /** Its agents in this history page, most recently active first. Never empty. */
  agents: ArchivedWorkspaceAgent[];
}

/** Which workspaces each host still lists as active. */
export type ActiveWorkspaceIdsByServer = ReadonlyMap<string, ReadonlySet<string>>;

function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function checkoutBranch(agent: AggregatedAgent): string | null {
  const checkout = agent.projectPlacement?.checkout;
  return checkout?.isGit ? checkout.currentBranch : null;
}

/**
 * Folds agent history into one entry per archived workspace, newest archive first. A
 * workspace its host still lists is active, so it is left out. So is an inactive workspace
 * with no archived agent: the user never put it away (a background workspace, for example).
 */
export function groupArchivedWorkspaces(input: {
  agents: readonly AggregatedAgent[];
  activeIds: ActiveWorkspaceIdsByServer;
}): ArchivedWorkspace[] {
  const byKey = new Map<string, ArchivedWorkspace & { archivedAtOrNull: Date | null }>();
  const newestFirst = [...input.agents].sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
  for (const agent of newestFirst) {
    const workspaceId = agent.workspaceId;
    if (!workspaceId || input.activeIds.get(agent.serverId)?.has(workspaceId)) continue;
    const key = `${agent.serverId}:${workspaceId}`;
    const archivedAt = agent.archivedAt ? new Date(agent.archivedAt) : null;
    const summary = { id: agent.id, title: agent.title ?? null, provider: agent.provider };
    const existing = byKey.get(key);
    if (existing) {
      existing.agents.push(summary);
      if (archivedAt && (!existing.archivedAtOrNull || archivedAt > existing.archivedAtOrNull)) {
        existing.archivedAtOrNull = archivedAt;
      }
      continue;
    }
    // The most recent agent describes the workspace: it saw its latest name and branch.
    const placement = agent.projectPlacement;
    byKey.set(key, {
      key,
      serverId: agent.serverId,
      workspaceId,
      name: placement?.workspaceName || lastPathSegment(agent.cwd),
      projectName: placement?.projectName ?? null,
      projectKey: placement?.projectKey ?? null,
      branch: checkoutBranch(agent),
      archivedAt: archivedAt ?? new Date(0),
      archivedAtOrNull: archivedAt,
      agents: [summary],
    });
  }

  const archived: ArchivedWorkspace[] = [];
  for (const { archivedAtOrNull, ...workspace } of byKey.values()) {
    if (archivedAtOrNull) archived.push({ ...workspace, archivedAt: archivedAtOrNull });
  }
  return archived.sort((left, right) => right.archivedAt.getTime() - left.archivedAt.getTime());
}
