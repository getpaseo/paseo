import { promises as fs } from "node:fs";
import { z } from "zod";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { WorkspaceLabelDefinitionSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

interface WorkspaceLabelCompoundRegistry {
  blockAllMutationsUntilRestart(): void;
  commitWorkspaceLabelMutation<TResult>(input: {
    stage: (records: ReadonlyMap<string, PersistedWorkspaceRecord>) => {
      updates: readonly PersistedWorkspaceRecord[];
      result: TResult;
      forcePersist: boolean;
    };
    beforeWorkspaceWrite: (records: readonly PersistedWorkspaceRecord[]) => Promise<void>;
    afterWorkspaceWrite: () => Promise<void>;
    afterCommit: () => void;
    publish?: boolean;
  }): Promise<TResult>;
}

interface WorkspaceLabelMutation<TResult> {
  labels: WorkspaceLabelDefinition[];
  workspaceUpdates: PersistedWorkspaceRecord[];
  result: TResult;
}

const WorkspaceLabelWorkspaceStateSchema = z.object({
  workspaceId: z.string(),
  labels: z.array(z.string()).optional(),
  updatedAt: z.string(),
});
const WorkspaceLabelTransactionSchema = z.object({
  phase: z.enum(["prepared", "committed"]),
  beforeLabels: z.array(WorkspaceLabelDefinitionSchema),
  afterLabels: z.array(WorkspaceLabelDefinitionSchema),
  beforeWorkspaces: z.array(WorkspaceLabelWorkspaceStateSchema),
  afterWorkspaces: z.array(WorkspaceLabelWorkspaceStateSchema),
});

type WorkspaceLabelTransaction = z.infer<typeof WorkspaceLabelTransactionSchema>;

export class WorkspaceLabelStorageUncertainError extends Error {
  readonly code = "workspace_label_storage_uncertain";

  constructor() {
    super("Workspace label storage outcome is uncertain; restart the daemon before retrying");
    this.name = "WorkspaceLabelStorageUncertainError";
  }
}

export class WorkspaceLabelCatalogStore {
  private loaded = false;
  private initializing: Promise<void> | null = null;
  private labels: WorkspaceLabelDefinition[] = [];
  private blocked = false;

  constructor(
    private readonly filePath: string,
    private readonly transactionPath: string,
    private readonly workspaces: WorkspaceLabelCompoundRegistry,
    private readonly writeCatalog: (
      filePath: string,
      labels: readonly WorkspaceLabelDefinition[],
    ) => Promise<void> = writeJsonFileAtomic,
    private readonly writeTransaction: (
      filePath: string,
      transaction: unknown,
    ) => Promise<void> = writeJsonFileAtomic,
    private readonly removeTransaction: (filePath: string) => Promise<void> = fs.rm,
  ) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (!this.initializing) {
      this.initializing = this.loadAndRecover().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  async list(): Promise<WorkspaceLabelDefinition[]> {
    await this.initialize();
    return this.labels.map((label) => ({ ...label }));
  }

  async commit<TResult>(
    planner: (
      labels: readonly WorkspaceLabelDefinition[],
      workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
    ) => WorkspaceLabelMutation<TResult>,
  ): Promise<TResult> {
    await this.initialize();
    if (this.blocked) throw new WorkspaceLabelStorageUncertainError();

    let mutation!: WorkspaceLabelMutation<TResult>;
    let transaction: WorkspaceLabelTransaction | null = null;
    const result = await this.workspaces
      .commitWorkspaceLabelMutation({
        stage: (workspaces) => {
          mutation = planner(this.labels, workspaces);
          transaction = transactionFor(this.labels, mutation, workspaces);
          return {
            updates: mutation.workspaceUpdates,
            result: mutation.result,
            forcePersist:
              mutation.workspaceUpdates.length > 0 || !catalogsEqual(this.labels, mutation.labels),
          };
        },
        beforeWorkspaceWrite: async () => {
          if (!transaction) throw new Error("Workspace label transaction was not staged");
          await this.writeTransaction(this.transactionPath, transaction);
          await this.writeCatalog(this.filePath, transaction.afterLabels);
        },
        afterWorkspaceWrite: async () => {
          if (!transaction) throw new Error("Workspace label transaction was not staged");
          transaction = { ...transaction, phase: "committed" };
          await this.writeTransaction(this.transactionPath, transaction);
        },
        afterCommit: () => {
          this.labels = [...mutation.labels];
        },
      })
      .catch(async (error: unknown) => {
        await this.resolveFailedCommit(error);
      });

    await this.removeTransaction(this.transactionPath).catch(() => undefined);
    return result as TResult;
  }

  private async resolveFailedCommit(error: unknown): Promise<never> {
    let durable: WorkspaceLabelTransaction | null;
    try {
      durable = await this.readTransaction();
    } catch {
      this.blockUntilRestart();
    }
    if (!durable) throw error;
    if (durable.phase === "committed") {
      this.blockUntilRestart();
    }
    try {
      await this.recover(durable);
    } catch {
      this.blockUntilRestart();
    }
    throw error;
  }

  private blockUntilRestart(): never {
    this.blocked = true;
    this.workspaces.blockAllMutationsUntilRestart();
    throw new WorkspaceLabelStorageUncertainError();
  }

  private async loadAndRecover(): Promise<void> {
    const transaction = await this.readTransaction();
    if (transaction) {
      await this.recover(transaction);
      this.loaded = true;
      return;
    }
    this.labels = await this.readCatalog();
    this.loaded = true;
  }

  private async readCatalog(): Promise<WorkspaceLabelDefinition[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return z.array(WorkspaceLabelDefinitionSchema).parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readTransaction(): Promise<WorkspaceLabelTransaction | null> {
    try {
      return await this.requireTransaction();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async requireTransaction(): Promise<WorkspaceLabelTransaction> {
    const raw = await fs.readFile(this.transactionPath, "utf8");
    return WorkspaceLabelTransactionSchema.parse(JSON.parse(raw));
  }

  private async recover(transaction: WorkspaceLabelTransaction): Promise<void> {
    if (transaction.phase === "committed") {
      // The marker exists only after both data files are durable. It is cleanup state, never an
      // instruction to replay stale after-images over newer workspace mutations.
      this.labels = await this.readCatalog();
      await this.removeTransaction(this.transactionPath).catch(() => undefined);
      return;
    }
    const labels = transaction.beforeLabels;
    const workspaceStates = transaction.beforeWorkspaces;
    await this.workspaces.commitWorkspaceLabelMutation({
      stage: (workspaces) => ({
        updates: workspaceStates.flatMap((state) => {
          const current = workspaces.get(state.workspaceId);
          return current ? [{ ...current, labels: state.labels, updatedAt: state.updatedAt }] : [];
        }),
        result: undefined,
        forcePersist: true,
      }),
      beforeWorkspaceWrite: () => this.writeCatalog(this.filePath, labels),
      afterWorkspaceWrite: () => this.removeTransaction(this.transactionPath),
      afterCommit: () => {
        this.labels = [...labels];
      },
      publish: false,
    });
  }
}

function transactionFor<TResult>(
  currentLabels: readonly WorkspaceLabelDefinition[],
  mutation: WorkspaceLabelMutation<TResult>,
  workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
): WorkspaceLabelTransaction {
  const beforeWorkspaces = mutation.workspaceUpdates.flatMap((workspace) => {
    const current = workspaces.get(workspace.workspaceId);
    return current ? [workspaceState(current)] : [];
  });
  return {
    phase: "prepared",
    beforeLabels: currentLabels.map((label) => ({ ...label })),
    afterLabels: mutation.labels.map((label) => ({ ...label })),
    beforeWorkspaces,
    afterWorkspaces: mutation.workspaceUpdates.map(workspaceState),
  };
}

function workspaceState(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    ...(workspace.labels ? { labels: [...workspace.labels] } : {}),
    updatedAt: workspace.updatedAt,
  };
}

function catalogsEqual(
  left: readonly WorkspaceLabelDefinition[],
  right: readonly WorkspaceLabelDefinition[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (label, index) => label.name === right[index]?.name && label.color === right[index]?.color,
    )
  );
}
