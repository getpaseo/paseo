import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import type { PersistedProjectKind, PersistedWorkspaceKind } from "./workspace-registry-model.js";

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
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  collectionId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

const PersistedWorkspaceCollectionRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;
export type PersistedWorkspaceCollectionRecord = z.infer<
  typeof PersistedWorkspaceCollectionRecordSchema
>;

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  setCustomName(
    projectId: string,
    customName: string | null,
    updatedAt: string,
    options?: { expectedCurrentNames?: readonly (string | null)[] },
  ): Promise<PersistedProjectRecord>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  unarchive?(projectId: string, updatedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
  subscribeChanges?(listener: (projectId: string) => void): () => void;
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
  setTitle?(
    workspaceId: string,
    title: string | null,
    updatedAt: string,
    options?: { expectedCurrentTitles?: readonly (string | null)[] },
  ): Promise<PersistedWorkspaceRecord>;
  archive(workspaceId: string, archivedAt: string): Promise<void>;
  unarchive?(workspaceId: string, updatedAt: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  setPinnedAt(workspaceId: string, pinnedAt: string | null): Promise<PersistedWorkspaceRecord>;
  setCollectionId(
    workspaceId: string,
    collectionId: string | null,
  ): Promise<PersistedWorkspaceRecord>;
  subscribeOrganizationChanges?(listener: (workspaceId: string) => void): () => void;
}

/**
 * Unarchives a project through the registry's atomic mutation when available.
 * Older custom registries predate that method, so preserve compatibility with
 * a read-modify-upsert fallback. File-backed registries always take the atomic
 * path and therefore retain their per-record serialization guarantees.
 */
export async function unarchiveProjectRegistryRecord(
  registry: Pick<ProjectRegistry, "get" | "unarchive" | "upsert">,
  projectId: string,
  updatedAt: string,
): Promise<void> {
  if (registry.unarchive) {
    await registry.unarchive(projectId, updatedAt);
    return;
  }
  const existing = await registry.get(projectId);
  if (!existing || existing.archivedAt === null) return;
  await registry.upsert({ ...existing, archivedAt: null, updatedAt });
}

/** Legacy-compatible counterpart to unarchiveProjectRegistryRecord. */
export async function unarchiveWorkspaceRegistryRecord(
  registry: Pick<WorkspaceRegistry, "get" | "unarchive" | "upsert">,
  workspaceId: string,
  updatedAt: string,
): Promise<void> {
  if (registry.unarchive) {
    await registry.unarchive(workspaceId, updatedAt);
    return;
  }
  const existing = await registry.get(workspaceId);
  if (!existing || existing.archivedAt === null) return;
  await registry.upsert({ ...existing, archivedAt: null, updatedAt });
}

/**
 * Sets a workspace title atomically when supported, with a compatibility
 * fallback for custom registries that only implement get/upsert.
 */
export async function setWorkspaceRegistryTitle(
  registry: Pick<WorkspaceRegistry, "get" | "setTitle" | "upsert">,
  workspaceId: string,
  title: string | null,
  updatedAt: string,
  options?: { expectedCurrentTitles?: readonly (string | null)[] },
): Promise<PersistedWorkspaceRecord> {
  if (registry.setTitle) {
    return registry.setTitle(workspaceId, title, updatedAt, options);
  }
  const existing = await registry.get(workspaceId);
  if (!existing) throw new Error(`Workspace ${workspaceId} not found`);
  if (options?.expectedCurrentTitles && !options.expectedCurrentTitles.includes(existing.title)) {
    return existing;
  }
  const updated = { ...existing, title, updatedAt };
  await registry.upsert(updated);
  return (await registry.get(workspaceId)) ?? updated;
}

export interface WorkspaceCollectionRegistry {
  initialize(): Promise<void>;
  list(): Promise<PersistedWorkspaceCollectionRecord[]>;
  get(id: string): Promise<PersistedWorkspaceCollectionRecord | null>;
  upsert(record: PersistedWorkspaceCollectionRecord): Promise<void>;
  remove(id: string): Promise<void>;
  subscribeChanges?(listener: () => void): () => void;
}

type RegistryRecord =
  | PersistedProjectRecord
  | PersistedWorkspaceRecord
  | PersistedWorkspaceCollectionRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private loadPromise: Promise<void> | null = null;

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
    return Array.from(this.cache.values(), (record) => this.schema.parse(record));
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    const record = this.cache.get(id);
    return record ? this.schema.parse(record) : null;
  }

  async upsert(record: TRecord): Promise<void> {
    const parsed = this.schema.parse(record);
    await this.mutateRecord(this.getId(parsed), () => parsed);
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    return this.mutateRecord(id, (existing) =>
      existing ? this.schema.parse(updater(this.schema.parse(existing))) : null,
    );
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.mutateRecord(id, (existing) => {
      if (!existing) {
        return existing;
      }
      return this.schema.parse({
        ...existing,
        updatedAt: archivedAt,
        archivedAt,
      });
    });
  }

  async unarchive(id: string, updatedAt: string): Promise<void> {
    await this.mutateRecord(id, (existing) => {
      if (!existing) {
        return existing;
      }
      if ("archivedAt" in existing && existing.archivedAt === null) {
        return existing;
      }
      return this.schema.parse({
        ...existing,
        updatedAt,
        archivedAt: null,
      });
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutateRecord(id, () => null);
  }

  protected async mutateRecord(
    id: string,
    mutate: (existing: TRecord | null) => TRecord | null,
  ): Promise<TRecord | null> {
    await this.load();
    const previous = this.mutationQueues.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationQueues.set(id, current);
    await previous.catch(() => undefined);
    try {
      const existing = this.cache.get(id) ?? null;
      const next = mutate(existing);
      if (next === existing) {
        return existing ? this.schema.parse(existing) : null;
      }
      if (next === null) {
        if (!this.cache.delete(id)) {
          return null;
        }
      } else {
        const parsed = this.schema.parse(next);
        this.cache.set(id, parsed);
        await this.enqueuePersist();
        this.onRecordChanged(id);
        return this.schema.parse(parsed);
      }
      await this.enqueuePersist();
      this.onRecordChanged(id);
      return null;
    } finally {
      release();
      if (this.mutationQueues.get(id) === current) {
        this.mutationQueues.delete(id);
      }
    }
  }

  protected async updateExistingRecord(
    id: string,
    update: (existing: TRecord) => TRecord,
    notFoundMessage: string,
  ): Promise<TRecord> {
    const next = await this.mutateRecord(id, (existing) => {
      if (!existing) {
        throw new Error(notFoundMessage);
      }
      return update(existing);
    });
    if (!next) {
      throw new Error(notFoundMessage);
    }
    return next;
  }

  protected onRecordChanged(_id: string): void {}

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
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
  private readonly changeListeners = new Set<(projectId: string) => void>();

  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
    });
  }

  override async upsert(record: PersistedProjectRecord): Promise<void> {
    const parsed = PersistedProjectRecordSchema.parse(record);
    await this.mutateRecord(parsed.projectId, (existing) =>
      existing
        ? PersistedProjectRecordSchema.parse({
            ...parsed,
            // User-owned fields have dedicated mutation methods. Generic
            // discovery and reconciliation refreshes must not replace them.
            customName: existing.customName,
            archivedAt: existing.archivedAt,
          })
        : parsed,
    );
  }

  async setCustomName(
    projectId: string,
    customName: string | null,
    updatedAt: string,
    options?: { expectedCurrentNames?: readonly (string | null)[] },
  ): Promise<PersistedProjectRecord> {
    return this.updateExistingRecord(
      projectId,
      (existing) => {
        const expectedCurrentNames = options?.expectedCurrentNames;
        if (expectedCurrentNames && !expectedCurrentNames.includes(existing.customName)) {
          return existing;
        }
        return PersistedProjectRecordSchema.parse({ ...existing, customName, updatedAt });
      },
      `Project ${projectId} not found`,
    );
  }

  subscribeChanges(listener: (projectId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  protected override onRecordChanged(projectId: string): void {
    for (const listener of this.changeListeners) {
      listener(projectId);
    }
  }
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly organizationListeners = new Set<(workspaceId: string) => void>();

  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
    });
  }

  override async upsert(record: PersistedWorkspaceRecord): Promise<void> {
    const parsed = PersistedWorkspaceRecordSchema.parse(record);
    await this.mutateRecord(parsed.workspaceId, (existing) =>
      existing
        ? PersistedWorkspaceRecordSchema.parse({
            ...parsed,
            // Organization fields have dedicated mutation methods. Generic
            // metadata refreshes must not replace a concurrent user action.
            title: existing.title,
            archivedAt: existing.archivedAt,
            pinnedAt: existing.pinnedAt,
            collectionId: existing.collectionId,
          })
        : parsed,
    );
  }

  async setTitle(
    workspaceId: string,
    title: string | null,
    updatedAt: string,
    options?: { expectedCurrentTitles?: readonly (string | null)[] },
  ): Promise<PersistedWorkspaceRecord> {
    return this.updateExistingRecord(
      workspaceId,
      (existing) => {
        const expectedCurrentTitles = options?.expectedCurrentTitles;
        if (expectedCurrentTitles && !expectedCurrentTitles.includes(existing.title)) {
          return existing;
        }
        return PersistedWorkspaceRecordSchema.parse({ ...existing, title, updatedAt });
      },
      `Workspace ${workspaceId} not found`,
    );
  }

  async setPinnedAt(
    workspaceId: string,
    pinnedAt: string | null,
  ): Promise<PersistedWorkspaceRecord> {
    const next = await this.updateExistingRecord(
      workspaceId,
      (existing) => PersistedWorkspaceRecordSchema.parse({ ...existing, pinnedAt }),
      `Workspace ${workspaceId} not found`,
    );
    this.emitOrganizationChange(workspaceId);
    return next;
  }

  async setCollectionId(
    workspaceId: string,
    collectionId: string | null,
  ): Promise<PersistedWorkspaceRecord> {
    const next = await this.updateExistingRecord(
      workspaceId,
      (existing) => PersistedWorkspaceRecordSchema.parse({ ...existing, collectionId }),
      `Workspace ${workspaceId} not found`,
    );
    this.emitOrganizationChange(workspaceId);
    return next;
  }

  subscribeOrganizationChanges(listener: (workspaceId: string) => void): () => void {
    this.organizationListeners.add(listener);
    return () => this.organizationListeners.delete(listener);
  }

  private emitOrganizationChange(workspaceId: string): void {
    for (const listener of this.organizationListeners) {
      listener(workspaceId);
    }
  }
}

export class FileBackedWorkspaceCollectionRegistry
  extends FileBackedRegistry<PersistedWorkspaceCollectionRecord>
  implements WorkspaceCollectionRegistry
{
  private readonly changeListeners = new Set<() => void>();

  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceCollectionRecordSchema,
      getId: (record) => record.id,
      component: "workspace-collections",
    });
  }

  override async upsert(record: PersistedWorkspaceCollectionRecord): Promise<void> {
    await super.upsert(record);
    this.emitChange();
  }

  override async remove(id: string): Promise<void> {
    await super.remove(id);
    this.emitChange();
  }

  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
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
  baseBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  collectionId?: string | null;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    baseBranch: input.baseBranch ?? null,
    archivedAt: input.archivedAt ?? null,
    pinnedAt: input.pinnedAt ?? null,
    collectionId: input.collectionId ?? null,
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
