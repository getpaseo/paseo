import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    extra: z.record(z.string(), z.any()).nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  pinnedAt: z.string().nullable().optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "extra"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

export interface AgentStorageRecordWriter {
  write(filePath: string, record: StoredAgentRecord): Promise<void>;
}

const defaultRecordWriter: AgentStorageRecordWriter = {
  write: writeJsonFileAtomic,
};

export interface AgentStorageOptions {
  recordWriter?: AgentStorageRecordWriter;
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;
  private readonly recordWriter: AgentStorageRecordWriter;
  private readonly pinListeners = new Set<(agentId: string) => void>();

  constructor(baseDir: string, logger: Logger, options: AgentStorageOptions = {}) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
    this.recordWriter = options.recordWriter ?? defaultRecordWriter;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    const parsed = parseStoredAgentRecord(record);
    await this.queueRecordOperation(parsed.id, async () => {
      await this.writeRecord(parsed);
    });
  }

  async update(
    agentId: string,
    updateRecord: (existing: StoredAgentRecord) => StoredAgentRecord,
  ): Promise<StoredAgentRecord> {
    await this.load();
    const next = await this.queueRecordOperation(agentId, async () => {
      const existing = this.cache.get(agentId);
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }
      const updated = parseStoredAgentRecord(updateRecord(existing));
      if (updated.id !== agentId) {
        throw new Error(`Agent update cannot change id from ${agentId} to ${updated.id}`);
      }
      await this.writeRecord(updated);
      return updated;
    });
    if (!next) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return next;
  }

  async setPinnedAt(agentId: string, pinnedAt: string | null): Promise<StoredAgentRecord> {
    const next = await this.update(agentId, (existing) => ({ ...existing, pinnedAt }));
    for (const listener of this.pinListeners) {
      listener(agentId);
    }
    return next;
  }

  subscribePinChanges(listener: (agentId: string) => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  private queueRecordOperation<TResult>(
    agentId: string,
    operation: () => Promise<TResult>,
    options?: { allowDeleting?: boolean },
  ): Promise<TResult | undefined> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingWrites.set(agentId, current);
    return (async () => {
      await prev.catch(() => undefined);
      try {
        if (this.deleting.has(agentId) && options?.allowDeleting !== true) {
          return undefined;
        }
        return await operation();
      } finally {
        release();
        if (this.pendingWrites.get(agentId) === current) {
          this.pendingWrites.delete(agentId);
        }
      }
    })();
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    await this.recordWriter.write(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await this.queueRecordOperation(
      agentId,
      async () => {
        const paths = Array.from(this.pathsById.get(agentId) ?? []);
        await Promise.all(
          paths.map(async (filePath) => {
            try {
              await fs.unlink(filePath);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code && code !== "ENOENT") {
                this.logger.warn(
                  { err: error, agentId, filePath },
                  "Failed to remove agent record file",
                );
              }
            }
          }),
        );

        this.cache.delete(agentId);
        this.pathById.delete(agentId);
        this.pathsById.delete(agentId);
      },
      { allowDeleting: true },
    );
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    await this.queueRecordOperation(agent.id, async () => {
      const existing = this.cache.get(agent.id) ?? null;
      const hasTitleOverride =
        options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
      const hasInternalOverride =
        options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive and organization state across snapshot
      // flushes. Neither field is owned by the ManagedAgent snapshot.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      if (existing && existing.pinnedAt !== undefined) {
        record.pinnedAt = existing.pinnedAt;
      }
      await this.writeRecord(record);
    });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.update(agentId, (record) => ({ ...record, title }));
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      records.push(record);
      this.cache.set(record.id, record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
