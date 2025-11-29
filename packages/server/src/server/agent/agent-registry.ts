import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { AgentStatusSchema } from "../messages.js";
import type { AgentSnapshot } from "./agent-manager.js";
import type { AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    extra: z.record(z.any()).nullable().optional(),
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
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  persistence: PERSISTENCE_HANDLE_SCHEMA,
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  "modeId" | "model" | "extra"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;

export class AgentRegistry {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private loaded = false;
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(resolveServerPackageRoot(), "agents.json");
  }

  async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = await this.parseContent(content);
      this.loaded = true;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        this.cache.clear();
        return [];
      }
      console.error("[AgentRegistry] Failed to load agents:", error);
      this.loaded = true;
      this.cache.clear();
      return [];
    }
  }

  async list(): Promise<StoredAgentRecord[]> {
    return this.load();
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cache.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    this.cache.set(record.id, record);
    await this.flush();
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.cache.delete(agentId);
    await this.flush();
  }

  async recordConfig(
    agentId: string,
    provider: AgentProvider,
    cwd: string,
    config?: SerializableAgentConfig
  ): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    const existing = this.cache.get(agentId);
    const sanitizedConfig = config ? sanitizeConfig(config) : existing?.config;
    const nextModeId =
      config?.modeId ??
      existing?.lastModeId ??
      sanitizedConfig?.modeId ??
      null;
    const updated: StoredAgentRecord = {
      id: agentId,
      provider,
      cwd,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastActivityAt: existing?.lastActivityAt ?? existing?.updatedAt ?? now,
      lastUserMessageAt: existing?.lastUserMessageAt ?? null,
      title: existing?.title ?? null,
      lastStatus: existing?.lastStatus ?? "closed",
      lastModeId: nextModeId,
      config: sanitizedConfig,
      persistence: existing?.persistence ?? null,
    };
    this.cache.set(agentId, updated);
    await this.flush();
  }

  async applySnapshot(snapshot: AgentSnapshot): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    const existing = this.cache.get(snapshot.id);
    if (!existing) {
      const record: StoredAgentRecord = {
        id: snapshot.id,
      provider: snapshot.provider,
      cwd: snapshot.cwd,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: snapshot.updatedAt.toISOString(),
      lastUserMessageAt: snapshot.lastUserMessageAt
        ? snapshot.lastUserMessageAt.toISOString()
        : null,
      title: null,
      lastStatus: snapshot.status,
      lastModeId: snapshot.currentModeId ?? null,
      config: null,
      persistence: snapshot.persistence ?? null,
      };
      this.cache.set(snapshot.id, record);
      await this.flush();
      return;
    }
    const updated: StoredAgentRecord = {
      ...existing,
      provider: snapshot.provider,
      cwd: snapshot.cwd,
      updatedAt: now,
      lastActivityAt: snapshot.updatedAt.toISOString(),
      lastUserMessageAt: snapshot.lastUserMessageAt
        ? snapshot.lastUserMessageAt.toISOString()
        : existing.lastUserMessageAt ?? null,
      lastStatus: snapshot.status,
      lastModeId: snapshot.currentModeId ?? null,
      persistence: snapshot.persistence ?? existing.persistence ?? null,
    };
    this.cache.set(snapshot.id, updated);
    await this.flush();
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    const record = this.cache.get(agentId);
    if (!record) {
      return;
    }
    this.cache.set(agentId, { ...record, title });
    await this.flush();
  }

  private async flush(): Promise<void> {
    const payload = JSON.stringify(Array.from(this.cache.values()), null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFileAtomically(this.filePath, payload);
  }

  private async parseContent(content: string): Promise<StoredAgentRecord[]> {
    try {
      return this.parseRecords(content);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const recovered = await this.tryRecoverCorruptedContent(content);
        if (recovered) {
          return recovered;
        }
      }
      throw error;
    }
  }

  private parseRecords(content: string): StoredAgentRecord[] {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid agents.json format");
    }
    const records: StoredAgentRecord[] = [];
    for (const entry of parsed) {
      try {
        const record = STORED_AGENT_SCHEMA.parse(entry);
        records.push(record);
        this.cache.set(record.id, record);
      } catch (error) {
        console.error("[AgentRegistry] Skipping invalid record:", error);
      }
    }
    return records;
  }

  private async tryRecoverCorruptedContent(
    content: string
  ): Promise<StoredAgentRecord[] | null> {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    const candidate = content.slice(start, end + 1);
    try {
      this.cache.clear();
      const records = this.parseRecords(candidate);
      console.warn(
        "[AgentRegistry] Recovered corrupted agents.json payload; rewrote sanitized copy"
      );
      const sanitizedPayload = JSON.stringify(records, null, 2);
      await writeFileAtomically(this.filePath, sanitizedPayload);
      return records;
    } catch (error) {
      this.cache.clear();
      return null;
    }
  }
}

function sanitizeConfig(
  config: SerializableAgentConfig | undefined
): SerializableAgentConfig | undefined {
  if (!config) {
    return undefined;
  }
  const cleaned: SerializableAgentConfig = {};
  if (config.modeId) cleaned.modeId = config.modeId;
  if (config.model) cleaned.model = config.model;
  if (config.extra) cleaned.extra = JSON.parse(JSON.stringify(config.extra));
  return cleaned;
}

function resolveServerPackageRoot(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        "[AgentRegistry] Failed to locate server package root for agents.json"
      );
    }
    currentDir = parentDir;
  }
}

async function writeFileAtomically(targetPath: string, payload: string) {
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.agents.json.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  );
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
