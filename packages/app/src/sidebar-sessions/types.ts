import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export type SidebarSessionViewMode = "workspaces" | "sessions";

export type SidebarSessionFilter = { type: "all" } | { type: "project"; projectKey: string };

export interface SidebarSessionWorkspace {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  workspaceName: string;
  projectKey: string;
  projectName: string;
  projectIconKey: string | null;
  workspaceDirectory: string;
}

export type ResolvedSidebarSessionProject = Pick<
  SidebarSessionWorkspace,
  "projectKey" | "projectName" | "projectIconKey"
>;

export type SidebarSessionAgent = Pick<AggregatedAgent, "id" | "serverId" | "cwd" | "archivedAt">;
