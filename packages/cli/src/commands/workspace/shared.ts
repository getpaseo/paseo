import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type {
  FetchWorkspacesEntry,
  FetchWorkspacesOptions,
  FetchWorkspacesPageInfo,
} from "@getpaseo/client/internal/daemon-client";
import type { OutputSchema } from "../../output/index.js";

export interface WorkspaceRow {
  workspaceId: string;
  project: string;
  name: string;
  isolation: "local" | "worktree";
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

const WORKSPACE_PAGE_LIMIT = 200;

export interface WorkspaceListClient {
  fetchWorkspaces(options?: FetchWorkspacesOptions): Promise<{
    entries: FetchWorkspacesEntry[];
    pageInfo: FetchWorkspacesPageInfo;
  }>;
}

/** Page through every active workspace the daemon knows about. */
export async function collectWorkspaces(
  client: WorkspaceListClient,
): Promise<FetchWorkspacesEntry[]> {
  const workspaces: FetchWorkspacesEntry[] = [];
  let cursor: string | undefined;
  do {
    const payload = await client.fetchWorkspaces({
      page: { limit: WORKSPACE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...payload.entries);
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return workspaces;
}

export function toWorkspaceRow(workspace: WorkspaceDescriptorPayload): WorkspaceRow {
  return {
    workspaceId: workspace.id,
    project: workspace.projectDisplayName,
    name: workspace.name,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    cwd: workspace.workspaceDirectory,
  };
}
