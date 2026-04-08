import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    title: z.string().nullable().optional(),
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.unknown()).nullable().optional(),
    extra: z.record(z.any()).nullable().optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.any()).optional(),
  })
  .nullable()
  .optional();

const STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string()).default({}),
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
      extra: z.record(z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "title"
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "extra"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;

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

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
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
    const agentId = record.id;
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return;
      }

      const nextPath = this.buildRecordPath(record);
      const previousPath = this.pathById.get(agentId);

      await fs.mkdir(path.dirname(nextPath), { recursive: true });
      await writeFileAtomically(nextPath, JSON.stringify(record, null, 2));
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
    });

    this.pendingWrites.set(
      agentId,
      next.finally(() => {
        if (this.pendingWrites.get(agentId) === next) {
          this.pendingWrites.delete(agentId);
        }
      }),
    );

    await next;
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    for (const filePath of paths) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          this.logger.warn({ err: error, agentId, filePath }, "Failed to remove agent record file");
        }
      }
    }

    this.cache.delete(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agent.id);
    const existing = (await this.get(agent.id)) ?? null;
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    const record = toStoredAgentRecord(agent, {
      title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
      createdAt: existing?.createdAt,
      internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
    });

    // Preserve soft-delete/archive status across snapshot flushes.
    // `archivedAt` is not part of the ManagedAgent snapshot, so a naive projection
    // would wipe it during normal persistence (including on daemon restart).
    if (existing && existing.archivedAt !== undefined) {
      record.archivedAt = existing.archivedAt;
    }
    await this.upsert(record);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
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

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const rootPath = path.join(this.baseDir, entry.name);
        const rootRecord = await this.readRecordFile(rootPath);
        if (!rootRecord) {
          continue;
        }
        records.push(rootRecord);
        this.cache.set(rootRecord.id, rootRecord);
        this.pathById.set(rootRecord.id, rootPath);
        this.addIndexedPath(rootRecord.id, rootPath);
        continue;
      }

      if (!entry.isDirectory()) {
        continue;
      }
      const projectDir = path.join(this.baseDir, entry.name);
      let files: Array<import("node:fs").Dirent> = [];
      try {
        files = await fs.readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(projectDir, file.name);
        const record = await this.readRecordFile(filePath);
        if (!record) {
          continue;
        }
        records.push(record);
        this.cache.set(record.id, record);
        this.pathById.set(record.id, filePath);
        this.addIndexedPath(record.id, filePath);
      }
    }

    return records;
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return STORED_AGENT_SCHEMA.parse(parsed);
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

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
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

async function writeFileAtomically(targetPath: string, payload: string) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(directory, `.agent.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
