import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";

export async function archivePersistedWorkspaceRecord(input: {
  workspaceId: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "archive">;
  projectRegistry: Pick<ProjectRegistry, "archive">;
  archivedAt?: string;
}): Promise<PersistedWorkspaceRecord | null> {
  const existingWorkspace = await input.workspaceRegistry.get(input.workspaceId);
  if (!existingWorkspace) {
    return null;
  }

  if (existingWorkspace.archivedAt) {
    return existingWorkspace;
  }

  const archivedAt = input.archivedAt ?? new Date().toISOString();
  await input.workspaceRegistry.archive(input.workspaceId, archivedAt);
  const activeSiblings = (await input.workspaceRegistry.list()).filter(
    (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
  );
  if (activeSiblings.length === 0) {
    await input.projectRegistry.archive(existingWorkspace.projectId, archivedAt);
  }

  return existingWorkspace;
}
