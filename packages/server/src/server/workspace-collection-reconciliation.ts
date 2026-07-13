import type { Logger } from "pino";
import type { WorkspaceCollectionRegistry, WorkspaceRegistry } from "./workspace-registry.js";

export async function reconcileDanglingWorkspaceCollectionAssignments(input: {
  workspaceRegistry: WorkspaceRegistry;
  workspaceCollectionRegistry: WorkspaceCollectionRegistry;
  logger: Logger;
}): Promise<string[]> {
  const [workspaces, collections] = await Promise.all([
    input.workspaceRegistry.list(),
    input.workspaceCollectionRegistry.list(),
  ]);
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const dangling = workspaces.filter(
    (workspace) => workspace.collectionId && !collectionIds.has(workspace.collectionId),
  );

  for (const workspace of dangling) {
    await input.workspaceRegistry.setCollectionId(workspace.workspaceId, null);
  }

  if (dangling.length > 0) {
    input.logger.warn(
      { workspaceIds: dangling.map((workspace) => workspace.workspaceId) },
      "Cleared dangling workspace collection assignments",
    );
  }
  return dangling.map((workspace) => workspace.workspaceId);
}
