// taskCreationService — adapted from emdash for hubcode
// Handles task creation logic: integration context seeding, worktree setup
import type { KanbanTask, TaskIntegrationContext } from "@/types/kanban";
import type {
  TaskMetadata,
  LinearIssueSummary,
  GitHubIssueSummary,
  JiraIssueSummary,
  GitLabIssueSummary,
  PlainThreadSummary,
  ForgejoIssueSummary,
} from "@/types/integrations";
import { generateFriendlyTaskName, normalizeTaskName } from "@/lib/task-names";

export interface CreateTaskParams {
  projectPath?: string;
  taskName: string;
  initialPrompt?: string;
  agentId?: string;
  agentProvider?: string;
  linkedLinearIssue?: LinearIssueSummary | null;
  linkedGithubIssue?: GitHubIssueSummary | null;
  linkedJiraIssue?: JiraIssueSummary | null;
  linkedGitlabIssue?: GitLabIssueSummary | null;
  linkedPlainThread?: PlainThreadSummary | null;
  linkedForgejoIssue?: ForgejoIssueSummary | null;
  autoApprove?: boolean;
  useWorktree?: boolean;
  baseRef?: string;
  nameGenerated?: boolean;
}

export interface CreateTaskResult {
  task: KanbanTask;
  warning?: string;
}

/**
 * Build task integration context from linked issues
 */
export function buildIntegrationContext(params: CreateTaskParams): TaskIntegrationContext {
  const ctx: TaskIntegrationContext = {};
  if (params.linkedLinearIssue) ctx.linearIssueId = params.linkedLinearIssue.id;
  if (params.linkedGithubIssue) ctx.githubIssueId = String(params.linkedGithubIssue.id);
  if (params.linkedJiraIssue) ctx.jiraIssueId = params.linkedJiraIssue.id;
  if (params.linkedGitlabIssue) ctx.gitlabIssueId = String(params.linkedGitlabIssue.id);
  if (params.linkedPlainThread) ctx.plainThreadId = params.linkedPlainThread.id;
  if (params.linkedForgejoIssue) ctx.forgejoIssueId = String(params.linkedForgejoIssue.id);
  return ctx;
}

/**
 * Build task metadata from linked issues (stored on the task for context injection)
 */
export function buildTaskMetadata(params: CreateTaskParams): TaskMetadata {
  const md: TaskMetadata = {};
  if (params.initialPrompt) md.initialPrompt = params.initialPrompt;
  if (params.autoApprove) md.autoApprove = params.autoApprove;
  if (params.linkedLinearIssue) md.linearIssue = params.linkedLinearIssue;
  if (params.linkedGithubIssue) md.githubIssue = params.linkedGithubIssue;
  if (params.linkedJiraIssue) md.jiraIssue = params.linkedJiraIssue;
  if (params.linkedGitlabIssue) md.gitlabIssue = params.linkedGitlabIssue;
  if (params.linkedPlainThread) md.plainThread = params.linkedPlainThread;
  if (params.linkedForgejoIssue) md.forgejoIssue = params.linkedForgejoIssue;
  return md;
}

/**
 * Build issue context text for prompt injection
 */
export function buildIssueContextPrompt(metadata: TaskMetadata): string | null {
  // Linear
  const issue = metadata.linearIssue;
  if (issue) {
    const parts: string[] = [
      `Linked Linear issue: ${issue.identifier}${issue.title ? ` — ${issue.title}` : ""}`,
    ];
    const details: string[] = [];
    if (issue.state?.name) details.push(`State: ${issue.state.name}`);
    if (issue.assignee?.name) details.push(`Assignee: ${issue.assignee.name}`);
    if (issue.team?.name) details.push(`Team: ${issue.team.name}`);
    if (issue.project?.name) details.push(`Project: ${issue.project.name}`);
    if (details.length) parts.push(`Details: ${details.join(" • ")}`);
    if (issue.url) parts.push(`URL: ${issue.url}`);
    if (issue.description) {
      const max = 1500;
      const body =
        issue.description.length > max
          ? issue.description.slice(0, max) + "\n…"
          : issue.description;
      parts.push("", "Issue Description:", body);
    }
    return parts.join("\n");
  }

  // GitHub
  const gh = metadata.githubIssue;
  if (gh) {
    const parts: string[] = [
      `Linked GitHub issue: #${gh.number}${gh.title ? ` — ${gh.title}` : ""}`,
    ];
    const details: string[] = [];
    if (gh.state) details.push(`State: ${gh.state}`);
    if (gh.assignees?.length) {
      const names = gh.assignees
        .map((a) => a.login || a.name)
        .filter(Boolean)
        .join(", ");
      if (names) details.push(`Assignees: ${names}`);
    }
    if (details.length) parts.push(`Details: ${details.join(" • ")}`);
    if (gh.url) parts.push(`URL: ${gh.url}`);
    if (gh.body) {
      const max = 1500;
      const body = gh.body.length > max ? gh.body.slice(0, max) + "\n…" : gh.body;
      parts.push("", "Issue Description:", body);
    }
    return parts.join("\n");
  }

  // Jira
  const j = metadata.jiraIssue;
  if (j) {
    const parts: string[] = [`Linked Jira issue: ${j.key}${j.title ? ` — ${j.title}` : ""}`];
    const details: string[] = [];
    if (j.status?.name) details.push(`Status: ${j.status.name}`);
    if (j.assignee?.name) details.push(`Assignee: ${j.assignee.name}`);
    if (j.projectKey) details.push(`Project: ${j.projectKey}`);
    if (details.length) parts.push(`Details: ${details.join(" • ")}`);
    if (j.url) parts.push(`URL: ${j.url}`);
    return parts.join("\n");
  }

  // GitLab
  const gl = metadata.gitlabIssue;
  if (gl) {
    const parts: string[] = [`Linked GitLab issue: #${gl.iid}${gl.title ? ` — ${gl.title}` : ""}`];
    if (gl.webUrl) parts.push(`URL: ${gl.webUrl}`);
    return parts.join("\n");
  }

  // Plain
  const pt = metadata.plainThread;
  if (pt) {
    const parts: string[] = [`Linked Plain thread: ${pt.title}`];
    if (pt.customer?.fullName) parts.push(`Customer: ${pt.customer.fullName}`);
    if (pt.status) parts.push(`Status: ${pt.status}`);
    return parts.join("\n");
  }

  // Forgejo
  const fg = metadata.forgejoIssue;
  if (fg) {
    const parts: string[] = [
      `Linked Forgejo issue: #${fg.number}${fg.title ? ` — ${fg.title}` : ""}`,
    ];
    if (fg.htmlUrl) parts.push(`URL: ${fg.htmlUrl}`);
    return parts.join("\n");
  }

  return null;
}

/**
 * Create a new task from params
 */
export function createTask(params: CreateTaskParams, existingNames: string[]): CreateTaskResult {
  const finalName = normalizeTaskName(params.taskName) || generateFriendlyTaskName(existingNames);
  const integrations = buildIntegrationContext(params);
  const metadata = buildTaskMetadata(params);

  const task: KanbanTask = {
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: finalName,
    createdAt: new Date().toISOString(),
    path: params.projectPath,
    agentId: params.agentId,
    agentProvider: params.agentProvider,
    prompt: params.initialPrompt?.trim() || undefined,
    autoApprove: params.autoApprove,
    useWorktree: params.useWorktree,
    integrations: Object.keys(integrations).length > 0 ? integrations : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  return { task };
}
