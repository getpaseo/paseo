import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export type WorkspacePullRequestState = "open" | "draft" | "merged" | "closed";

export interface WorkspacePullRequestRow {
  number: number | null;
  url: string;
  title: string;
  state: WorkspacePullRequestState;
  checksStatus: "none" | "pending" | "success" | "failure" | null;
  reviewDecision: "approved" | "changes_requested" | "pending" | null;
}

export interface WorkspaceRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
  labels: string[];
  branch: string | null;
  pullRequest: WorkspacePullRequestRow | null;
  cwd: string;
}

export type WorkspaceRowSource = Pick<
  WorkspaceDescriptorPayload,
  | "id"
  | "projectDisplayName"
  | "name"
  | "workspaceKind"
  | "workspaceDirectory"
  | "labels"
  | "gitRuntime"
  | "githubRuntime"
>;

type WorkspacePullRequestPayload = NonNullable<
  NonNullable<WorkspaceRowSource["githubRuntime"]>["pullRequest"]
>;

function formatPullRequestCell(pullRequest: WorkspacePullRequestRow | null): string {
  if (!pullRequest) {
    return "-";
  }
  return pullRequest.number === null
    ? pullRequest.state
    : `#${pullRequest.number} ${pullRequest.state}`;
}

export const workspaceSchema: OutputSchema<WorkspaceRow> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    {
      header: "LABELS",
      field: (row) => (row.labels.length > 0 ? row.labels.join(", ") : "-"),
      width: 12,
    },
    { header: "PR", field: (row) => formatPullRequestCell(row.pullRequest), width: 12 },
    { header: "CWD", field: "cwd", width: 42 },
  ],
};

function derivePullRequestState(
  pullRequest: WorkspacePullRequestPayload,
): WorkspacePullRequestState {
  const state = pullRequest.state.toLowerCase();
  if (pullRequest.isMerged || state === "merged") {
    return "merged";
  }
  if (state !== "open") {
    return "closed";
  }
  if (pullRequest.isDraft) {
    return "draft";
  }
  return "open";
}

function toPullRequestRow(workspace: WorkspaceRowSource): WorkspacePullRequestRow | null {
  const pullRequest = workspace.githubRuntime?.pullRequest;
  if (!pullRequest) {
    return null;
  }
  return {
    number: pullRequest.number ?? null,
    url: pullRequest.url,
    title: pullRequest.title,
    state: derivePullRequestState(pullRequest),
    checksStatus: pullRequest.checksStatus ?? null,
    reviewDecision: pullRequest.reviewDecision ?? null,
  };
}

export function toWorkspaceRow(workspace: WorkspaceRowSource): WorkspaceRow {
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    // COMPAT(workspaceLabels): hosts before v0.5.0 omit labels; remove the fallback after 2027-08-14.
    labels: [...(workspace.labels ?? [])],
    branch: workspace.gitRuntime?.currentBranch ?? null,
    pullRequest: toPullRequestRow(workspace),
    cwd: workspace.workspaceDirectory,
  };
}
