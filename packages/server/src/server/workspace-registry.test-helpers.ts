import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import {
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: (record: unknown) => TRecord;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: (record: unknown) => TRecord;
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
    const parsed = this.schema(record);
    this.cache.set(this.getId(parsed), parsed);
    await this.enqueuePersist();
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return;
    }
    const next = this.schema({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
    });
    this.cache.set(id, next);
    await this.enqueuePersist();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    if (!this.cache.delete(id)) {
      return;
    }
    await this.enqueuePersist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TRecord[];
      for (const record of parsed) {
        const validated = this.schema(record);
        this.cache.set(this.getId(validated), validated);
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(records, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
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
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: (record) => createPersistedProjectRecord(record as PersistedProjectRecord),
      getId: (record) => record.projectId,
      component: "projects",
    });
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
      schema: (record) => createPersistedWorkspaceRecord(record as PersistedWorkspaceRecord),
      getId: (record) => record.workspaceId,
      component: "workspaces",
    });
  }
}
