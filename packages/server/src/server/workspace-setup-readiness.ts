import type { WorkspaceSetupSnapshot } from "./messages.js";

type WorkspaceSetupOutcome = { status: "completed" } | { status: "failed"; error: unknown };

interface WorkspaceSetupEntry {
  completion: Promise<WorkspaceSetupOutcome>;
  status: "pending" | "completed" | "failed";
}

interface SharedWorkspaceSetup {
  completion: Promise<WorkspaceSetupOutcome>;
  abortController: AbortController;
}

export interface WorkspaceSetupPersistence {
  markPending(workspaceId: string): Promise<void>;
  markCompleted(workspaceId: string): Promise<void>;
  markFailed(workspaceId: string, error: string): Promise<void>;
}

export class WorkspaceSetupFailedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly setupError: unknown,
  ) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    super(`Workspace setup failed: ${detail}`, { cause: setupError });
    this.name = "WorkspaceSetupFailedError";
  }
}

export class WorkspaceSetupReadiness {
  private readonly entries = new Map<string, WorkspaceSetupEntry>();
  private readonly setupsByWorktreePath = new Map<string, SharedWorkspaceSetup>();
  private readonly worktreePathByWorkspace = new Map<string, string>();
  private readonly workspaceIdsByWorktreePath = new Map<string, Set<string>>();
  private readonly snapshots = new Map<string, WorkspaceSetupSnapshot>();

  constructor(private readonly persistence?: WorkspaceSetupPersistence) {}

  start(
    workspaceId: string,
    worktreePath: string,
    setup: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.entries.has(workspaceId)) {
      throw new Error(`Workspace setup already started for ${workspaceId}`);
    }
    this.registerWorkspacePath(workspaceId, worktreePath);
    const pendingPersisted = this.persistence?.markPending(workspaceId) ?? Promise.resolve();

    let sharedSetup = this.setupsByWorktreePath.get(worktreePath);
    if (!sharedSetup) {
      const abortController = new AbortController();
      const completion = pendingPersisted
        .then(() => setup(abortController.signal))
        .then<WorkspaceSetupOutcome, WorkspaceSetupOutcome>(
          () => ({ status: "completed" }),
          (error: unknown) => ({ status: "failed", error }),
        );
      sharedSetup = { completion, abortController };
      this.setupsByWorktreePath.set(worktreePath, sharedSetup);
    }

    const entry: WorkspaceSetupEntry = {
      completion: Promise.resolve({ status: "completed" }),
      status: "pending",
    };
    const completion = this.persistWorkspaceOutcome(
      workspaceId,
      pendingPersisted,
      sharedSetup.completion,
    )
      .catch((error: unknown) => ({ status: "failed" as const, error }))
      .then((outcome) => {
        entry.status = outcome.status;
        return outcome;
      });
    entry.completion = completion;
    this.entries.set(workspaceId, entry);
    return pendingPersisted;
  }

  restoreInterrupted(
    workspaceId: string,
    worktreePath: string,
    branchName: string | null,
    detail: string,
  ): void {
    const outcome = Promise.resolve<WorkspaceSetupOutcome>({
      status: "failed",
      error: new Error(detail),
    });
    this.setupsByWorktreePath.set(worktreePath, {
      completion: outcome,
      abortController: new AbortController(),
    });
    this.registerWorkspacePath(workspaceId, worktreePath);
    this.entries.set(workspaceId, { completion: outcome, status: "failed" });
    this.setSnapshot(workspaceId, {
      status: "failed",
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: branchName ?? "",
        commands: [],
        log: "",
      },
      error: detail,
    });
  }

  async waitUntilReady(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return;
    }
    const outcome = await entry.completion;
    if (outcome.status === "failed") {
      throw new WorkspaceSetupFailedError(workspaceId, outcome.error);
    }
  }

  isPending(workspaceId: string): boolean {
    return this.entries.get(workspaceId)?.status === "pending";
  }

  setSnapshot(workspaceId: string, snapshot: WorkspaceSetupSnapshot): string[] {
    const worktreePath = this.worktreePathByWorkspace.get(workspaceId);
    const workspaceIds = worktreePath
      ? this.workspaceIdsByWorktreePath.get(worktreePath)
      : undefined;
    if (!workspaceIds) {
      this.snapshots.set(workspaceId, snapshot);
      return [workspaceId];
    }
    for (const relatedWorkspaceId of workspaceIds) {
      this.snapshots.set(relatedWorkspaceId, snapshot);
    }
    return Array.from(workspaceIds);
  }

  getSnapshot(workspaceId: string): WorkspaceSetupSnapshot | null {
    return this.snapshots.get(workspaceId) ?? null;
  }

  async stop(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    const worktreePath = this.worktreePathByWorkspace.get(workspaceId);
    this.forget(workspaceId);
    if (worktreePath && this.workspaceIdsByWorktreePath.has(worktreePath)) {
      return;
    }
    await entry?.completion;
  }

  async stopAll(): Promise<void> {
    const completions = Array.from(this.entries.values(), (entry) => entry.completion);
    for (const setup of this.setupsByWorktreePath.values()) {
      setup.abortController.abort(new Error("Workspace setup canceled because the daemon stopped"));
    }
    await Promise.all(completions);
  }

  forget(workspaceId: string): void {
    this.entries.delete(workspaceId);
    this.snapshots.delete(workspaceId);
    const worktreePath = this.worktreePathByWorkspace.get(workspaceId);
    if (!worktreePath) return;
    this.worktreePathByWorkspace.delete(workspaceId);
    const workspaceIds = this.workspaceIdsByWorktreePath.get(worktreePath);
    workspaceIds?.delete(workspaceId);
    if (workspaceIds && workspaceIds.size === 0) {
      this.workspaceIdsByWorktreePath.delete(worktreePath);
      this.setupsByWorktreePath
        .get(worktreePath)
        ?.abortController.abort(
          new Error(`Workspace setup canceled because ${workspaceId} was archived`),
        );
      this.setupsByWorktreePath.delete(worktreePath);
    }
  }

  private registerWorkspacePath(workspaceId: string, worktreePath: string): void {
    this.worktreePathByWorkspace.set(workspaceId, worktreePath);
    const workspaceIds = this.workspaceIdsByWorktreePath.get(worktreePath) ?? new Set<string>();
    const currentSnapshot = Array.from(workspaceIds, (relatedWorkspaceId) =>
      this.snapshots.get(relatedWorkspaceId),
    ).find((snapshot) => snapshot !== undefined);
    workspaceIds.add(workspaceId);
    this.workspaceIdsByWorktreePath.set(worktreePath, workspaceIds);
    if (currentSnapshot) {
      this.snapshots.set(workspaceId, currentSnapshot);
    }
  }

  private async persistWorkspaceOutcome(
    workspaceId: string,
    pendingPersisted: Promise<void>,
    sharedCompletion: Promise<WorkspaceSetupOutcome>,
  ): Promise<WorkspaceSetupOutcome> {
    await pendingPersisted;
    const outcome = await sharedCompletion;
    if (outcome.status === "completed") {
      await this.persistence?.markCompleted(workspaceId);
    } else {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      await this.persistence?.markFailed(workspaceId, detail);
    }
    return outcome;
  }
}
