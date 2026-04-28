// Integration-specific types — adapted from emdash's per-provider types

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state?: { name?: string; color?: string; type?: string } | null;
  assignee?: { name?: string; avatarUrl?: string } | null;
  project?: { name?: string } | null;
  team?: { name?: string; key?: string } | null;
  priority?: number | null;
  labels?: Array<{ name: string; color?: string }>;
}

export interface GitHubIssueSummary {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state?: string | null;
  url?: string | null;
  assignees?: Array<{ login?: string; name?: string; avatarUrl?: string }>;
  labels?: Array<{ name: string; color?: string }>;
  repository?: string | null;
}

export interface JiraIssueSummary {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  status?: { name?: string; color?: string } | null;
  assignee?: { name?: string; avatarUrl?: string } | null;
  priority?: { name?: string; iconUrl?: string } | null;
  url?: string | null;
  projectKey?: string | null;
}

export interface GitLabIssueSummary {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state?: string | null;
  webUrl?: string | null;
  assignees?: Array<{ name?: string; username?: string; avatarUrl?: string }>;
  labels?: string[];
  projectPath?: string | null;
}

export interface PlainThreadSummary {
  id: string;
  externalId?: string;
  title: string;
  previewText?: string | null;
  status?: string | null;
  customer?: { fullName?: string; email?: string } | null;
  assignee?: { fullName?: string } | null;
  labels?: Array<{ name: string }>;
}

export interface ForgejoIssueSummary {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state?: string | null;
  htmlUrl?: string | null;
  assignees?: Array<{ login?: string; fullName?: string }>;
  labels?: Array<{ name: string; color?: string }>;
  repository?: { fullName?: string } | null;
}

export interface SentryIssueSummary {
  id: string;
  title: string;
  culprit?: string | null;
  count?: number;
  firstSeen?: string;
  lastSeen?: string;
  level?: string;
  permalink?: string | null;
}

// Chat task metadata type — adapted from emdash's chat.ts
export interface TaskMetadata {
  initialPrompt?: string;
  initialInjectionSent?: boolean;
  autoApprove?: boolean;
  multiAgent?: {
    enabled?: boolean;
    selectedAgent?: string;
    agents?: string[];
    agentRuns?: Array<{ agent: string; path?: string }>;
    variants?: Array<{
      path?: string;
      agent?: string;
      name?: string;
      branch?: string;
      worktreeId?: string;
    }>;
  };
  linearIssue?: LinearIssueSummary;
  githubIssue?: GitHubIssueSummary;
  jiraIssue?: JiraIssueSummary;
  gitlabIssue?: GitLabIssueSummary;
  plainThread?: PlainThreadSummary;
  forgejoIssue?: ForgejoIssueSummary;
  sentryIssue?: SentryIssueSummary;
}
