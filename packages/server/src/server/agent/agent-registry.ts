import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getRootLogger } from "../logger.js";

const logger = getRootLogger().child({ module: "agent", component: "agent-registry" });

import { AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

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
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.unknown()).optional(),
    })
    .optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  parentAgentId: z.string().nullable().optional(),
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
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
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
      logger.error({ err: error }, "Failed to load agents");
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

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null }
  ): Promise<void> {
    await this.load();
    const existing = this.cache.get(agent.id);
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const record = toStoredAgentRecord(agent, {
      title: hasTitleOverride ? options?.title ?? null : existing?.title ?? null,
      createdAt: existing?.createdAt,
    });
    this.cache.set(agent.id, record);
    await this.flush();
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    const record = this.cache.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
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
        logger.error({ err: error }, "Skipping invalid record");
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
      logger.warn("Recovered corrupted agents.json payload; rewrote sanitized copy");
      const sanitizedPayload = JSON.stringify(records, null, 2);
      await writeFileAtomically(this.filePath, sanitizedPayload);
      return records;
    } catch (error) {
      this.cache.clear();
      return null;
    }
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
