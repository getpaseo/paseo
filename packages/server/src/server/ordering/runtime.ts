import { join } from "node:path";
import type { Logger } from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { InactiveOrderScopeError, OrderingService, type OrderSetInput } from "./index.js";

export interface OrderingRuntime {
  service: OrderingService;
  dispose(): void;
}

export interface CreateOrderingRuntimeInput {
  paseoHome: string;
  projects: ProjectRegistry & Required<Pick<ProjectRegistry, "subscribeToMutations">>;
  workspaces: WorkspaceRegistry & Required<Pick<WorkspaceRegistry, "subscribeToMutations">>;
  logger: Logger;
}

export async function createOrderingRuntime(
  input: CreateOrderingRuntimeInput,
): Promise<OrderingRuntime> {
  const service = new OrderingService({
    filePath: join(input.paseoHome, "projects", "ui-order.json"),
    validate,
    logger: input.logger,
  });
  await service.initialize();
  await prune();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let dirty = false;

  const schedulePrune = (): void => {
    if (disposed) return;
    dirty = true;
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = null;
      void flushPrune();
    }, 0);
  };

  async function flushPrune(): Promise<void> {
    if (disposed || running || !dirty) return;
    running = (async () => {
      while (dirty) {
        dirty = false;
        if (disposed) break;
        try {
          await prune();
        } catch (error) {
          reportPruneFailure(error);
        }
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }

  const releases = [
    input.workspaces.subscribeToMutations((mutation) => {
      if (mutation.kind !== "upsert" || !mutation.workspace?.pinnedAt) schedulePrune();
    }),
    input.projects.subscribeToMutations((mutation) => {
      if (mutation.kind !== "upsert") schedulePrune();
    }),
  ];
  return {
    service,
    dispose: () => {
      disposed = true;
      dirty = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
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
      if (!workspace || workspace.archivedAt)
        throw new InactiveOrderScopeError("Workspace is not active");
      return;
    }
    if (scope.kind === "workspaces") {
      const project = await input.projects.get(scope.projectId);
      if (!project || project.archivedAt) throw new Error("Project is not active");
    }
    const workspaces = new Map(
      (await input.workspaces.listAll()).map((workspace) => [workspace.workspaceId, workspace]),
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
    await service.prune({
      load: async () => {
        const [projects, workspaces] = await Promise.all([
          input.projects.list(),
          input.workspaces.listAll(),
        ]);
        return {
          pinnedWorkspaceIds: new Set(
            workspaces
              .filter((workspace) => !workspace.archivedAt && workspace.pinnedAt)
              .map((workspace) => workspace.workspaceId),
          ),
          projectIds: new Set(
            projects.filter((project) => !project.archivedAt).map((project) => project.projectId),
          ),
          workspaceIds: new Set(
            workspaces
              .filter((workspace) => !workspace.archivedAt)
              .map((workspace) => workspace.workspaceId),
          ),
        };
      },
    });
  }
}
