import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { deriveProjectDisplayName, deriveProjectKey } from "@/utils/agent-grouping";

export const ALL_PROJECTS_OPTION_ID = "all";

export interface SessionProjectOption {
  /** Stable identity used for filtering; never the display label. */
  projectKey: string;
  label: string;
  /** Newest session in this project; orders the dropdown. */
  lastActivityAt: Date;
}

/**
 * Same identity rule as the sidebar grouping: the daemon's remote-first
 * placement key when present, the cwd-derived key otherwise.
 */
export function sessionProjectKey(agent: AggregatedAgent): string {
  return agent.projectPlacement?.projectKey ?? deriveProjectKey(agent.cwd);
}

/**
 * One option per project, deduplicated by key and ordered by most recent
 * session activity. Only projects in the already-loaded history pages appear.
 */
export function buildSessionProjectOptions(agents: AggregatedAgent[]): SessionProjectOption[] {
  const byKey = new Map<string, SessionProjectOption>();
  for (const agent of agents) {
    const projectKey = sessionProjectKey(agent);
    if (!projectKey) {
      continue;
    }
    const existing = byKey.get(projectKey);
    if (existing && existing.lastActivityAt.getTime() >= agent.lastActivityAt.getTime()) {
      continue;
    }
    byKey.set(projectKey, {
      projectKey,
      label: deriveProjectDisplayName({
        projectKey,
        projectName: agent.projectPlacement?.projectName ?? "",
      }),
      lastActivityAt: agent.lastActivityAt,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );
}

/** "all" returns the input array unchanged so memoized callers keep identity. */
export function filterAgentsByProject(
  agents: AggregatedAgent[],
  projectKey: string,
): AggregatedAgent[] {
  if (projectKey === ALL_PROJECTS_OPTION_ID) {
    return agents;
  }
  return agents.filter((agent) => sessionProjectKey(agent) === projectKey);
}

/**
 * Trigger label for a key that may no longer appear in the loaded pages —
 * rebuilt from the key itself so the control never falls back to a raw id.
 */
export function sessionProjectLabel(projectKey: string): string {
  if (projectKey === ALL_PROJECTS_OPTION_ID) {
    return "";
  }
  return deriveProjectDisplayName({ projectKey, projectName: "" });
}
