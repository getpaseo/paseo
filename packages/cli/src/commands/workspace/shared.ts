import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export interface WorkspaceRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree" | "chat";
  cwd: string;
}

export const workspaceSchema: OutputSchema<WorkspaceRow> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "PROJECT", field: "project", width: 20 },
    { header: "NAME", field: "name", width: 22 },
    { header: "ISOLATION", field: "isolation", width: 10 },
    { header: "CWD", field: "cwd", width: 42 },
  ],
};

function resolveWorkspaceRowIsolation(
  kind: WorkspaceDescriptorPayload["workspaceKind"],
): "local" | "worktree" | "chat" {
  if (kind === "worktree") return "worktree";
  if (kind === "chat") return "chat";
  return "local";
}

export function toWorkspaceRow(workspace: WorkspaceDescriptorPayload): WorkspaceRow {
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation: resolveWorkspaceRowIsolation(workspace.workspaceKind),
    cwd: workspace.workspaceDirectory,
  };
}
