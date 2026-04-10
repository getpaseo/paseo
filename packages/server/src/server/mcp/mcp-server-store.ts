import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type { McpServerConfig } from "../agent/agent-sdk-types.js";
import type {
  CreateMcpServerInput,
  McpServerRecord,
  McpServersStoreData,
  UpdateMcpServerInput,
} from "./mcp-server-types.js";

const MCP_SERVER_CONFIG_SCHEMA = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
]);

const MCP_SERVER_RECORD_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["stdio", "http", "sse"]),
  config: MCP_SERVER_CONFIG_SCHEMA,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const MCP_SERVERS_STORE_SCHEMA = z.object({
  servers: z.array(MCP_SERVER_RECORD_SCHEMA),
});

export class McpServerStore {
  private cache: Map<string, McpServerRecord> = new Map();
  private loaded = false;
  private filePath: string;
  private loadPromise: Promise<void> | null = null;
  private logger: Logger;

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger.child({
      module: "mcp",
      component: "mcp-server-store",
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(): Promise<McpServerRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async listEnabled(): Promise<McpServerRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((s) => s.enabled);
  }

  async get(id: string): Promise<McpServerRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async getByIds(ids: string[]): Promise<McpServerRecord[]> {
    await this.load();
    return ids
      .map((id) => this.cache.get(id))
      .filter((server): server is McpServerRecord => server !== undefined);
  }

  async add(input: CreateMcpServerInput): Promise<McpServerRecord> {
    await this.load();

    const now = new Date().toISOString();
    const record: McpServerRecord = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      config: input.config,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
      description: input.description,
    };

    this.cache.set(record.id, record);
    await this.save();

    return record;
  }

  async update(id: string, updates: UpdateMcpServerInput): Promise<McpServerRecord | null> {
    await this.load();

    const existing = this.cache.get(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const updated: McpServerRecord = {
      ...existing,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.type !== undefined && { type: updates.type }),
      ...(updates.config !== undefined && { config: updates.config }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
      ...(updates.tags !== undefined && { tags: updates.tags }),
      ...(updates.description !== undefined && { description: updates.description }),
      updatedAt: now,
    };

    this.cache.set(id, updated);
    await this.save();

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();

    if (!this.cache.has(id)) {
      return false;
    }

    this.cache.delete(id);
    await this.save();

    return true;
  }

  async enable(id: string): Promise<boolean> {
    return this.update(id, { enabled: true }).then((r) => r !== null);
  }

  async disable(id: string): Promise<boolean> {
    return this.update(id, { enabled: false }).then((r) => r !== null);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.performLoad();
    await this.loadPromise;
    this.loadPromise = null;
  }

  private async performLoad(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      const validated = MCP_SERVERS_STORE_SCHEMA.parse(parsed);

      this.cache.clear();
      for (const server of validated.servers) {
        this.cache.set(server.id, server);
      }

      this.loaded = true;
      this.logger.info({ count: validated.servers.length }, "Loaded MCP servers from disk");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        this.logger.info("MCP servers file not found, starting with empty store");
        this.loaded = true;
        return;
      }

      this.logger.error({ err }, "Failed to load MCP servers from disk");
      throw err;
    }
  }

  private async save(): Promise<void> {
    const data: McpServersStoreData = {
      servers: Array.from(this.cache.values()),
    };

    await writeFileAtomically(this.filePath, JSON.stringify(data, null, 2));
    this.logger.debug({ count: data.servers.length }, "Saved MCP servers to disk");
  }

  resolveMcpServers(serverIds?: string[]): Record<string, McpServerConfig> | undefined {
    if (!serverIds || serverIds.length === 0) {
      return undefined;
    }

    const servers = Array.from(this.cache.values()).filter(
      (s) => s.enabled && serverIds.includes(s.id),
    );

    if (servers.length === 0) {
      return undefined;
    }

    return servers.reduce(
      (acc, server) => {
        acc[server.name] = server.config;
        return acc;
      },
      {} as Record<string, McpServerConfig>,
    );
  }
}

async function writeFileAtomically(targetPath: string, payload: string): Promise<void> {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.mcp-servers.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );

  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, targetPath);
}
