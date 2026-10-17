import type { ProjectSummary, WorkspaceSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";

/** A workspace a schedule can run in: not being archived. */
export interface ScheduleProjectWorkspace {
  id: string;
  name: string;
  workspaceKind: WorkspaceSummary["workspaceKind"];
  background: boolean;
}

export interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectViewKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
  workspaces: readonly ScheduleProjectWorkspace[];
}

/** A workspace a schedule is bound to, as the schedules list names it. */
export interface ScheduleWorkspaceRef {
  name: string;
  projectName: string;
}

export function buildScheduleWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
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
        workspaces: host.workspaces
          .filter((workspace) => !workspace.archivingAt)
          .map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            workspaceKind: workspace.workspaceKind,
            background: workspace.background === true,
          })),
      });
    }
  }
  return targets;
}

/**
 * Map (serverId, workspaceId) -> workspace and project name for naming the
 * workspace a schedule runs in. Built from the same targets as the form's picker,
 * so a workspace being archived is missing from both: a schedule bound to one is
 * about to lose its target.
 */
export function buildScheduleWorkspaceIndex(
  targets: readonly ScheduleProjectTarget[],
): Map<string, ScheduleWorkspaceRef> {
  const index = new Map<string, ScheduleWorkspaceRef>();
  for (const target of targets) {
    for (const workspace of target.workspaces) {
      index.set(buildScheduleWorkspaceKey(target.serverId, workspace.id), {
        name: workspace.name,
        projectName: target.projectName,
      });
    }
  }
  return index;
}

/**
 * Whether a workspace missing from the targets is really gone: the host's workspaces have
 * loaded and the host is online. An offline host is left out of the targets and its loaded flag
 * is not cleared on disconnect, so absence then says nothing. Once loaded, an empty list is a
 * real answer: a host's projects and workspaces are committed from one snapshot, so a host with
 * no projects at all is not a cold cache. The schedules list and the form both ask this, so they
 * never disagree.
 */
export function canJudgeWorkspaceMissing(input: {
  workspacesLoaded: boolean;
  hostOnline: boolean;
}): boolean {
  return input.workspacesLoaded && input.hostOnline;
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
