import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  generateProjectId,
  type PersistedProjectKind,
  type PersistedWorkspaceKind,
} from "./workspace-registry-model.js";

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Exact checkout/worktree root backing cwd. This differs from cwd when the
  // selected project is a subdirectory inside a repository. Persist it so
  // archive and recovery do not need the directory to still exist in order to
  // recover placement.
  worktreeRoot: z.string().nullable().default(null),
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  isPaseoOwnedWorktree: z.boolean().default(false),
  mainRepoRoot: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
  /** Central lifecycle seam for daemon-global project observers. */
  subscribeToMutations?(
    listener: (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>,
  ): () => void;
}

export interface WorkspaceRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord): Promise<void>;
  archive(workspaceId: string, archivedAt: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    await this.load();
    const parsed = this.schema.parse(record);
    this.cache.set(this.getId(parsed), parsed);
    await this.enqueuePersist();
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return null;
    }
    const next = this.schema.parse(updater(existing));
    this.cache.set(id, next);
    await this.enqueuePersist();
    return next;
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) return;
    await this.persistArchive(existing, archivedAt);
  }

  protected async archiveIfActive(id: string, archivedAt: string): Promise<TRecord | null> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing || existing.archivedAt) {
      return null;
    }
    return this.persistArchive(existing, archivedAt);
  }

  private async persistArchive(existing: TRecord, archivedAt: string): Promise<TRecord> {
    const next = this.schema.parse({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
    });
    this.cache.set(this.getId(next), next);
    await this.enqueuePersist();
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.removeIfPresent(id);
  }

  protected async removeIfPresent(id: string): Promise<TRecord | null> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return null;
    }
    this.cache.delete(id);
    await this.enqueuePersist();
    return existing;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = z.array(this.schema).parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const records = Array.from(this.cache.values());
    await writeJsonFileAtomic(this.filePath, records);
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly projectIdFactory: () => string;
  private readonly mutationListeners = new Set<
    (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>
  >();

  constructor(filePath: string, logger: Logger, options?: { projectIdFactory?: () => string }) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
    });
    this.projectIdFactory = options?.projectIdFactory ?? generateProjectId;
  }

  async getOrCreateActiveByRoot(input: {
    rootPath: string;
    kind: PersistedProjectKind;
    displayName: string;
    timestamp: string;
  }): Promise<PersistedProjectRecord> {
    const previous = this.allocationQueue;
    let release!: () => void;
    this.allocationQueue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const active = (await this.list())
        .filter(
          (project) => !project.archivedAt && areEquivalentPaths(project.rootPath, input.rootPath),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.projectId.localeCompare(right.projectId),
        )[0];
      if (active) {
        if (active.kind === input.kind) return active;
        const refreshed = { ...active, kind: input.kind, updatedAt: input.timestamp };
        await this.upsert(refreshed);
        return refreshed;
      }

      for (;;) {
        const projectId = this.projectIdFactory();
        if (await this.get(projectId)) continue;
        const record = createPersistedProjectRecord({
          projectId,
          rootPath: input.rootPath,
          kind: input.kind,
          displayName: input.displayName,
          createdAt: input.timestamp,
          updatedAt: input.timestamp,
        });
        await this.upsert(record);
        return record;
      }
    } finally {
      release();
    }
  }

  subscribeToMutations(
    listener: (mutation: {
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: PersistedProjectRecord | null;
    }) => void | Promise<void>,
  ): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  override async upsert(record: PersistedProjectRecord): Promise<void> {
    await super.upsert(record);
    await this.notifyMutation({ kind: "upsert", projectId: record.projectId, project: record });
  }

  override async archive(projectId: string, archivedAt: string): Promise<void> {
    const project = await this.archiveIfActive(projectId, archivedAt);
    if (!project) return;
    await this.notifyMutation({ kind: "archive", projectId, project });
  }

  override async remove(projectId: string): Promise<void> {
    const project = await this.removeIfPresent(projectId);
    if (!project) return;
    await this.notifyMutation({ kind: "remove", projectId, project: null });
  }

  private async notifyMutation(mutation: {
    kind: "upsert" | "archive" | "remove";
    projectId: string;
    project: PersistedProjectRecord | null;
  }): Promise<void> {
    await Promise.all([...this.mutationListeners].map((listener) => listener(mutation)));
  }
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
    });
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  worktreeRoot?: string | null;
  baseBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    worktreeRoot: input.worktreeRoot ?? null,
    baseBranch: input.baseBranch ?? null,
    isPaseoOwnedWorktree: input.isPaseoOwnedWorktree ?? false,
    mainRepoRoot: input.mainRepoRoot ?? null,
    archivedAt: input.archivedAt ?? null,
    pinnedAt: input.pinnedAt ?? null,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}
