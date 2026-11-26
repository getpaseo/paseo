import type { ProjectSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";

export interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectViewKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
}

export function buildProjectOptionId(serverId: string, projectViewKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectViewKey}`;
}

/**
 * The project roots the schedule form can target: one per online host of each
 * project, keyed by (serverId, cwd). The schedules list reuses this set to name
 * a schedule's stored cwd; the two surfaces must agree on what "a project" is.
 */
export function buildScheduleProjectTargets(
  projects: readonly ProjectSummary[],
): ScheduleProjectTarget[] {
  const targets: ScheduleProjectTarget[] = [];
  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      targets.push({
        optionId: buildProjectOptionId(host.serverId, project.viewKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectViewKey: project.viewKey,
        projectName: host.projectName,
        cwd,
        isGit: Boolean(host.gitRuntime),
      });
    }
  }
  return targets;
}

function projectNameKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd.trim()}`;
}

/** Map (serverId, cwd) -> project name for naming a schedule's stored cwd. */
export function buildProjectNameByCwd(
  targets: readonly ScheduleProjectTarget[],
): Map<string, string> {
  const byCwd = new Map<string, string>();
  for (const target of targets) {
    byCwd.set(projectNameKey(target.serverId, target.cwd), target.projectName);
  }
  return byCwd;
}

/**
 * Name a stored cwd for display: the matching project name when the client
 * knows this root on this host, otherwise the shortened path itself. Never
 * blank, never a claim the client cannot back up.
 */
export function describeScheduleCwd(input: {
  serverId: string;
  cwd: string;
  projectNameByCwd: ReadonlyMap<string, string>;
}): string {
  return (
    input.projectNameByCwd.get(projectNameKey(input.serverId, input.cwd)) ?? shortenPath(input.cwd)
  );
}

export interface ScheduleWorkspaceOption {
  id: string;
  label: string;
}

/**
 * The workspaces the schedules list can filter by: one option per distinct
 * (serverId, cwd) among the schedules, named like the row's target line.
 */
export function buildScheduleWorkspaceOptions(
  targets: ReadonlyArray<{ serverId: string; cwd: string }>,
  projectNameByCwd: ReadonlyMap<string, string>,
): ScheduleWorkspaceOption[] {
  const seen = new Set<string>();
  const options: ScheduleWorkspaceOption[] = [];
  for (const target of targets) {
    const id = `${target.serverId}:${target.cwd}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({
      id,
      label: describeScheduleCwd({
        serverId: target.serverId,
        cwd: target.cwd,
        projectNameByCwd,
      }),
    });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}
