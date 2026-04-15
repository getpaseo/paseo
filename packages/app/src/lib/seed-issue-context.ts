// seedIssueContext — Formats linked issue data as context for the agent chat.
// Adapted from emdash's taskCreationService.ts seedIssueContext() function.
//
// Returns a formatted string that can be injected into the conversation
// as an initial system/agent message so the AI agent has context about the
// linked external issue.

import type { TaskMetadata } from "@/types/integrations";

export interface IssueContext {
  provider: string;
  identifier: string;
  title: string;
  url?: string | null;
  details: string[];
  description?: string | null;
}

/** Build context objects from task metadata for all linked issues */
export function extractIssueContexts(metadata: TaskMetadata | undefined): IssueContext[] {
  if (!metadata) return [];
  const contexts: IssueContext[] = [];

  if (metadata.linearIssue) {
    const issue = metadata.linearIssue;
    const details: string[] = [];
    if (issue.state) details.push(`State: ${issue.state}`);
    if (issue.assignee) details.push(`Assignee: ${issue.assignee}`);
    if (issue.team) details.push(`Team: ${issue.team}`);
    if (issue.project) details.push(`Project: ${issue.project}`);

    contexts.push({
      provider: "Linear",
      identifier: issue.identifier ?? String(issue.id),
      title: issue.title,
      url: issue.url,
      details,
      description: issue.description,
    });
  }

  if (metadata.githubIssue) {
    const issue = metadata.githubIssue;
    const details: string[] = [];
    if (issue.state) details.push(`State: ${issue.state}`);
    if (issue.repository) details.push(`Repository: ${issue.repository}`);
    if (issue.assignees?.length) {
      details.push(`Assignees: ${issue.assignees.join(", ")}`);
    }

    contexts.push({
      provider: "GitHub",
      identifier: `#${issue.number}`,
      title: issue.title,
      url: issue.url,
      details,
      description: issue.body,
    });
  }

  if (metadata.jiraIssue) {
    const issue = metadata.jiraIssue;
    const details: string[] = [];
    if (issue.status) details.push(`Status: ${issue.status}`);
    if (issue.assignee) details.push(`Assignee: ${issue.assignee}`);
    if (issue.priority) details.push(`Priority: ${issue.priority}`);

    contexts.push({
      provider: "Jira",
      identifier: issue.key,
      title: issue.title,
      url: issue.url,
      details,
      description: issue.description,
    });
  }

  if (metadata.gitlabIssue) {
    const issue = metadata.gitlabIssue;
    const details: string[] = [];
    if (issue.state) details.push(`State: ${issue.state}`);
    if (issue.projectPath) details.push(`Project: ${issue.projectPath}`);

    contexts.push({
      provider: "GitLab",
      identifier: `#${issue.iid}`,
      title: issue.title,
      url: issue.webUrl,
      details,
      description: issue.description,
    });
  }

  if (metadata.plainThread) {
    const thread = metadata.plainThread;
    const details: string[] = [];
    if (thread.status) details.push(`Status: ${thread.status}`);
    if (thread.customer)
      details.push(
        `Customer: ${typeof thread.customer === "string" ? thread.customer : ((thread.customer as { fullName?: string })?.fullName ?? "")}`,
      );

    contexts.push({
      provider: "Plain",
      identifier: thread.externalId ?? String(thread.id),
      title: thread.title,
      url: undefined,
      details,
      description: thread.previewText,
    });
  }

  if (metadata.forgejoIssue) {
    const issue = metadata.forgejoIssue;
    const details: string[] = [];
    if (issue.state) details.push(`State: ${issue.state}`);
    if (issue.repository) details.push(`Repository: ${issue.repository}`);

    contexts.push({
      provider: "Forgejo",
      identifier: `#${issue.number}`,
      title: issue.title,
      url: issue.htmlUrl,
      details,
      description: issue.body,
    });
  }

  if (metadata.sentryIssue) {
    const issue = metadata.sentryIssue;
    const details: string[] = [];
    if (issue.level) details.push(`Level: ${issue.level}`);
    if (issue.culprit) details.push(`Culprit: ${issue.culprit}`);
    if (issue.count) details.push(`Events: ${issue.count}`);
    if (issue.lastSeen) details.push(`Last seen: ${issue.lastSeen}`);

    contexts.push({
      provider: "Sentry",
      identifier: String(issue.id),
      title: issue.title,
      url: issue.permalink,
      details,
      description: undefined,
    });
  }

  return contexts;
}

/** Format a single issue context into a human-readable string for injection */
export function formatIssueContext(ctx: IssueContext): string {
  const lines: string[] = [];

  lines.push(`Linked ${ctx.provider} issue: ${ctx.identifier} \u2014 ${ctx.title}`);

  if (ctx.details.length > 0) {
    lines.push(`Details: ${ctx.details.join(" \u2022 ")}`);
  }

  if (ctx.url) {
    lines.push(`URL: ${ctx.url}`);
  }

  if (ctx.description) {
    lines.push("");
    lines.push("Issue Description:");
    lines.push(ctx.description);
  }

  return lines.join("\n");
}

/** Format all linked issue contexts from task metadata into a single string */
export function seedIssueContext(metadata: TaskMetadata | undefined): string | null {
  const contexts = extractIssueContexts(metadata);
  if (contexts.length === 0) return null;

  return contexts.map(formatIssueContext).join("\n\n---\n\n");
}
