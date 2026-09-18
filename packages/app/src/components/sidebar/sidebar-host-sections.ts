import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

/**
 * One host's slice of the sidebar, always rendered under that host's divider.
 *
 * Both grouping modes carry their content here: `projects` is the Project-mode body (project
 * headers and their rows, narrowed to this host) and `workspaceGroups` is the Status-mode body.
 * The projection fills both once so the list only chooses which to render, and the keyboard
 * shortcut walk reads the same sections the rows come from.
 */
export interface SidebarHostSection {
  key: string;
  serverId: string;
  label: string;
  projects: SidebarProjectEntry[];
  workspaceGroups: SidebarWorkspaceGroup[];
}

/**
 * Splits the unpinned sidebar into one section per host.
 *
 * Hosts are ordered the way the host switcher orders them — by label, then by server id so two
 * hosts sharing a name stay put. A project that spans hosts appears once under each, with that
 * host's workspaces and host entries; an empty project still appears under the host it is known
 * on, because its row owns the New workspace action even with no workspaces yet.
 */
export function buildSidebarHostSections(input: {
  projects: SidebarProjectEntry[];
  unpinnedWorkspaces: SidebarWorkspaceEntry[];
  projectNamesByViewKey: Map<string, string>;
  hostLabelsByServerId: ReadonlyMap<string, string>;
}): SidebarHostSection[] {
  const serverIds = new Set<string>();
  for (const project of input.projects) {
    for (const host of project.hosts) {
      serverIds.add(host.serverId);
    }
  }
  for (const workspace of input.unpinnedWorkspaces) {
    serverIds.add(workspace.serverId);
  }

  const sections = [...serverIds].map((serverId) => ({
    key: `host:${serverId}`,
    serverId,
    label: hostLabel(serverId, input.hostLabelsByServerId),
    projects: input.projects
      .filter(
        (project) =>
          project.hosts.some((host) => host.serverId === serverId) ||
          project.workspaces.some((workspace) => workspace.serverId === serverId),
      )
      .map((project) => narrowProjectToHost(project, serverId)),
    workspaceGroups: statusWorkspaceGroups(
      buildStatusGroups(
        input.unpinnedWorkspaces.filter((workspace) => workspace.serverId === serverId),
        input.projectNamesByViewKey,
      ),
    ),
  }));

  sections.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return sections.filter(
    (section) => section.projects.length > 0 || section.workspaceGroups.length > 0,
  );
}

function narrowProjectToHost(project: SidebarProjectEntry, serverId: string): SidebarProjectEntry {
  const workspaces = project.workspaces.filter((workspace) => workspace.serverId === serverId);
  const hosts = project.hosts.filter((host) => host.serverId === serverId);
  if (workspaces.length === project.workspaces.length && hosts.length === project.hosts.length) {
    return project;
  }
  return { ...project, workspaces, hosts };
}

function hostLabel(serverId: string, hostLabelsByServerId: ReadonlyMap<string, string>): string {
  const label = hostLabelsByServerId.get(serverId)?.trim();
  return label || serverId;
}
