import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export interface SidebarProjectHostTarget {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

export type SidebarProjectTrailingAction =
  | { kind: "new_workspace"; target: SidebarProjectHostTarget }
  | { kind: "none" };

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  chevron: "expand" | "collapse";
  trailingAction: SidebarProjectTrailingAction;
}

export type SidebarProjectRowModel = SidebarProjectSectionRowModel;

const EMPTY_MULTIPLICITY_MAP: ReadonlyMap<string, boolean> = new Map();
const EMPTY_STATUS_MAP: ReadonlyMap<string, HostRuntimeConnectionStatus> = new Map();
function hostTarget(input: {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}): SidebarProjectHostTarget | null {
  const iconWorkingDir = input.iconWorkingDir.trim();
  if (!input.serverId || !iconWorkingDir) {
    return null;
  }
  return {
    serverId: input.serverId,
    projectId: input.projectId,
    iconWorkingDir,
    customIconRevision: input.customIconRevision,
    iconRevision: input.iconRevision,
  };
}

export function resolveSidebarProjectIconTarget(
  project: SidebarProjectEntry,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

export type SidebarProjectIconTarget = ProjectIconTarget;

export function resolveSidebarProjectIconTargets(
  projects: readonly SidebarProjectEntry[],
): SidebarProjectIconTarget[] {
  return projects.flatMap((project) => {
    const target = resolveSidebarProjectIconTarget(project);
    const iconTarget = target
      ? createProjectIconTarget({ projectViewKey: project.viewKey, placement: target })
      : null;
    return iconTarget ? [iconTarget] : [];
  });
}

export function resolveSidebarProjectLocalPath(
  project: SidebarProjectEntry,
  localServerId: string | null,
): string {
  if (!localServerId) return "";
  return project.hosts.find((host) => host.serverId === localServerId)?.iconWorkingDir.trim() ?? "";
}

// A project can host a brand-new workspace on a host when that host can create a
// git worktree (git projects) OR the host supports running multiple independent
// workspaces per directory (`workspaceMultiplicity`), which is what lets non-git
// directories add a second workspace. Mirrors the gate used by the global "New
// workspace" affordances (use-global-new-workspace-action.ts and left-sidebar's
// SidebarNewWorkspaceHeaderRow): `canCreateWorktree || supportsMultiplicity`.
function canHostNewWorkspace(
  host: SidebarProjectEntry["hosts"][number],
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>,
): boolean {
  return (
    host.worktreeSupport !== "unsupported" ||
    supportsMultiplicityByServerId.get(host.serverId) === true
  );
}

interface NewWorkspaceTargetInput {
  project: SidebarProjectEntry;
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean>;
  preferredServerId: string | null | undefined;
  hostConnectionStatusByServerId: ReadonlyMap<string, HostRuntimeConnectionStatus>;
}

function resolveNewWorkspaceTarget(
  input: NewWorkspaceTargetInput,
): SidebarProjectHostTarget | null {
  const qualifyingHosts = input.project.hosts.filter((host) =>
    canHostNewWorkspace(host, input.supportsMultiplicityByServerId),
  );

  // This row navigates with an explicit `?serverId=`, which the composer honours
  // outright, so an offline remembered host would stick with nothing to correct it.
  const preferredServerId = input.preferredServerId?.trim() ?? "";
  if (
    preferredServerId &&
    input.hostConnectionStatusByServerId.get(preferredServerId) === "online"
  ) {
    const preferredHost = qualifyingHosts.find((host) => host.serverId === preferredServerId);
    const preferredTarget = preferredHost ? hostTarget(preferredHost) : null;
    if (preferredTarget) return preferredTarget;
  }

  for (const host of qualifyingHosts) {
    const target = hostTarget(host);
    if (target) return target;
  }
  return null;
}

function projectTrailingAction(input: NewWorkspaceTargetInput): SidebarProjectTrailingAction {
  const target = resolveNewWorkspaceTarget(input);
  return target ? { kind: "new_workspace", target } : { kind: "none" };
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
  collapsed: boolean;
  supportsMultiplicityByServerId?: ReadonlyMap<string, boolean>;
  preferredServerId?: string | null;
  hostConnectionStatusByServerId?: ReadonlyMap<string, HostRuntimeConnectionStatus>;
}): SidebarProjectRowModel {
  return {
    kind: "project_section",
    chevron: input.collapsed ? "expand" : "collapse",
    trailingAction: projectTrailingAction({
      project: input.project,
      supportsMultiplicityByServerId:
        input.supportsMultiplicityByServerId ?? EMPTY_MULTIPLICITY_MAP,
      preferredServerId: input.preferredServerId,
      hostConnectionStatusByServerId: input.hostConnectionStatusByServerId ?? EMPTY_STATUS_MAP,
    }),
  };
}
