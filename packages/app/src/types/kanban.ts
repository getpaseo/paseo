// Kanban task types — adapted from emdash's task/kanban flow

export type KanbanStatus = "todo" | "in-progress" | "done";

export const KANBAN_COLUMNS: KanbanStatus[] = ["todo", "in-progress", "done"];

export const KANBAN_TITLES: Record<KanbanStatus, string> = {
  todo: "To-do",
  "in-progress": "In-progress",
  done: "Ready for review",
};

export interface KanbanTask {
  id: string;
  name: string;
  serverId?: string;
  projectId?: string;
  projectName?: string;
  branch?: string;
  path?: string;
  agentId?: string;
  agentProvider?: string;
  /** "native" = GUI chat agent, "cli" = terminal CLI agent */
  agentMode?: "native" | "cli";
  /** Terminal ID when running a CLI agent */
  terminalId?: string;
  createdAt: string; // ISO date
  prompt?: string;
  autoApprove?: boolean;
  useWorktree?: boolean;
  integrations?: TaskIntegrationContext;
  metadata?: import("@/types/integrations").TaskMetadata;
}

export interface TaskIntegrationContext {
  linearIssueId?: string;
  githubIssueId?: string;
  jiraIssueId?: string;
  gitlabIssueId?: string;
  plainThreadId?: string;
  forgejoIssueId?: string;
  sentryIssueId?: string;
}

export type IntegrationId =
  | "github"
  | "linear"
  | "jira"
  | "gitlab"
  | "plain"
  | "forgejo"
  | "sentry";

export interface IntegrationRegistryEntry {
  id: IntegrationId;
  name: string;
  description: string;
}

export const INTEGRATION_REGISTRY: readonly IntegrationRegistryEntry[] = [
  { id: "github", name: "GitHub", description: "Connect your repositories" },
  { id: "linear", name: "Linear", description: "Work on Linear tickets" },
  { id: "jira", name: "Jira", description: "Work on Jira tickets" },
  { id: "gitlab", name: "GitLab", description: "Work on GitLab issues" },
  { id: "plain", name: "Plain", description: "Work on support threads" },
  { id: "forgejo", name: "Forgejo", description: "Work on Forgejo issues" },
  { id: "sentry", name: "Sentry", description: "Fix errors from Sentry" },
] as const;

export const INTEGRATION_LABELS: Record<IntegrationId, string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
  gitlab: "GitLab",
  plain: "Plain",
  forgejo: "Forgejo",
  sentry: "Sentry",
};

export type IntegrationStatusMap = Record<IntegrationId, boolean>;

export const DEFAULT_INTEGRATION_STATUS: IntegrationStatusMap = {
  github: false,
  linear: false,
  jira: false,
  gitlab: false,
  plain: false,
  forgejo: false,
  sentry: false,
};
