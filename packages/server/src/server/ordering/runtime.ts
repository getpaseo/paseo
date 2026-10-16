import { join } from "node:path";
import type { Logger } from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { OrderingService, type OrderSetInput } from "./index.js";

export interface OrderingRuntime {
  service: OrderingService;
  dispose(): void;
}

export async function createOrderingRuntime(input: {
  paseoHome: string;
  projects: ProjectRegistry & Required<Pick<ProjectRegistry, "subscribeToMutations">>;
  workspaces: WorkspaceRegistry & Required<Pick<WorkspaceRegistry, "subscribeToMutations">>;
  logger: Logger;
}): Promise<OrderingRuntime> {
  const service = new OrderingService(join(input.paseoHome, "projects", "ui-order.json"), validate);
  await service.initialize();
  await prune();
  const releases = [
    input.workspaces.subscribeToMutations((mutation) => {
      if (mutation.kind !== "upsert") return prune().catch(reportPruneFailure);
      if (!mutation.workspace?.pinnedAt)
        return service.removePinned(mutation.workspaceId).catch(reportPruneFailure);
    }),
    input.projects.subscribeToMutations((mutation) => {
      if (mutation.kind !== "upsert") return prune().catch(reportPruneFailure);
    }),
  ];
  return {
    service,
    dispose: () => {
      for (const release of releases) release();
    },
  };

  function reportPruneFailure(error: unknown): void {
    // Registry mutations are already durable. A preference write must not report archive failure.
    input.logger.error({ err: error }, "Failed to prune shared ordering");
  }

  async function validate({ scope, order }: OrderSetInput): Promise<void> {
    if (scope.kind === "tabs") {
      const workspace = await input.workspaces.get(scope.workspaceId);
      if (!workspace || workspace.archivedAt) throw new Error("Workspace is not active");
      return;
    }
    if (scope.kind === "workspaces") {
      const project = await input.projects.get(scope.projectId);
      if (!project || project.archivedAt) throw new Error("Project is not active");
    }
    const workspaces = new Map(
      (await input.workspaces.list()).map((workspace) => [workspace.workspaceId, workspace]),
    );
    for (const id of order) {
      const workspace = workspaces.get(id);
      if (
        !workspace ||
        workspace.archivedAt ||
        (scope.kind === "workspaces" && workspace.projectId !== scope.projectId) ||
        (scope.kind === "pinned" && !workspace.pinnedAt)
      )
        throw new Error("Order contains a workspace outside its scope");
    }
  }

  async function prune(): Promise<void> {
    const [projects, workspaces] = await Promise.all([
      input.projects.list(),
      input.workspaces.list(),
    ]);
    await service.prune({
      projectIds: new Set(
        projects.filter((project) => !project.archivedAt).map((project) => project.projectId),
      ),
      workspaceIds: new Set(
        workspaces
          .filter((workspace) => !workspace.archivedAt)
          .map((workspace) => workspace.workspaceId),
      ),
    });
    for (const workspace of workspaces) {
      if (!workspace.pinnedAt) await service.removePinned(workspace.workspaceId);
    }
  }
}
