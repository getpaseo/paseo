import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarProjectWorkspaceLinkRowModel {
  kind: "workspace_link";
  workspace: SidebarWorkspaceEntry;
  chevron: null;
  trailingAction: "new_worktree" | "none";
}

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  chevron: "expand" | "collapse" | null;
  trailingAction: "new_worktree" | "none";
}

export type SidebarProjectRowModel =
  | SidebarProjectWorkspaceLinkRowModel
  | SidebarProjectSectionRowModel;

export function isSidebarProjectFlattened(project: SidebarProjectEntry): boolean {
  return project.workspaces.length === 1 && project.projectKind !== "git";
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
  collapsed: boolean;
}): SidebarProjectRowModel {
  const flattenedWorkspace = isSidebarProjectFlattened(input.project)
    ? (input.project.workspaces[0] ?? null)
    : null;

  if (flattenedWorkspace) {
    return {
      kind: "workspace_link",
      workspace: flattenedWorkspace,
      chevron: null,
      trailingAction: input.project.projectKind === "git" ? "new_worktree" : "none",
    };
  }

  const collapsible = input.project.projectKind === "git" || input.project.workspaces.length > 1;

  return {
    kind: "project_section",
    chevron: collapsible ? (input.collapsed ? "expand" : "collapse") : null,
    trailingAction: input.project.projectKind === "git" ? "new_worktree" : "none",
  };
}
