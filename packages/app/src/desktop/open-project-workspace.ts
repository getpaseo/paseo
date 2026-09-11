import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

interface OpenProjectWorkspaceInput {
  client: Pick<DaemonClient, "addProject" | "fetchWorkspaces" | "createWorkspace">;
  path: string;
}

export async function openProjectWorkspace(
  input: OpenProjectWorkspaceInput,
): Promise<WorkspaceDescriptorPayload> {
  const added = await input.client.addProject(input.path);
  if (added.error || !added.project) {
    throw new Error(added.error ?? "Unable to add project");
  }

  const projectId = added.project.projectId;
  let cursor: string | undefined;
  do {
    const page = await input.client.fetchWorkspaces({
      filter: { projectId },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    const existing = page.entries.find(
      (workspace) => workspace.workspaceDirectory === input.path && !workspace.archivingAt,
    );
    if (existing) return existing;
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);

  const created = await input.client.createWorkspace({
    source: { kind: "directory", path: input.path, projectId },
  });
  if (created.error || !created.workspace) {
    throw new Error(created.error ?? "Unable to create workspace");
  }
  return created.workspace;
}
