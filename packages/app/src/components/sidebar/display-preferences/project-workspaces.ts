/** How project groups expose their workspaces in the sidebar. */
export const SIDEBAR_PROJECT_WORKSPACE_DISPLAYS = ["rows", "compact"] as const;

export type SidebarProjectWorkspaceDisplay = (typeof SIDEBAR_PROJECT_WORKSPACE_DISPLAYS)[number];

export const DEFAULT_SIDEBAR_PROJECT_WORKSPACE_DISPLAY: SidebarProjectWorkspaceDisplay = "rows";
