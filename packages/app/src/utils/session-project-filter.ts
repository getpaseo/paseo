import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export const SESSIONS_ALL_PROJECTS_FILTER_ID = "all-projects";

export interface SessionProjectFilterOption {
  id: string;
  label: string;
}

function projectFilterIdForAgent(agent: AggregatedAgent): string | null {
  const placement = agent.projectPlacement;
  if (placement?.projectKey?.trim()) {
    return placement.projectKey.trim();
  }
  if (placement?.projectName?.trim()) {
    return `name:${placement.projectName.trim().toLowerCase()}`;
  }
  const cwd = agent.cwd?.trim();
  if (cwd) {
    return `cwd:${cwd}`;
  }
  return null;
}

function projectFilterLabelForAgent(agent: AggregatedAgent): string {
  const placement = agent.projectPlacement;
  if (placement?.projectName?.trim()) {
    return placement.projectName.trim();
  }
  if (placement?.projectKey?.trim()) {
    return placement.projectKey.trim();
  }
  const cwd = agent.cwd?.trim();
  if (cwd) {
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }
  return "Unknown project";
}

export function buildSessionProjectFilterOptions(
  agents: readonly AggregatedAgent[],
): SessionProjectFilterOption[] {
  const byId = new Map<string, string>();
  for (const agent of agents) {
    const id = projectFilterIdForAgent(agent);
    if (!id || byId.has(id)) {
      continue;
    }
    byId.set(id, projectFilterLabelForAgent(agent));
  }
  return Array.from(byId.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }),
    );
}

export function filterAgentsByProject(
  agents: readonly AggregatedAgent[],
  projectFilterId: string,
): AggregatedAgent[] {
  if (projectFilterId === SESSIONS_ALL_PROJECTS_FILTER_ID) {
    return [...agents];
  }
  return agents.filter((agent) => projectFilterIdForAgent(agent) === projectFilterId);
}
