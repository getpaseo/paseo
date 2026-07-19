import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import {
  McpServerSchema,
  McpServerCreateInputSchema,
  McpServerUpdateInputSchema,
  type McpServer,
  type McpServerCreateInput,
  type McpServerUpdateInput,
} from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const MCP_STORE_VERSION = 1;

const McpStorePayloadSchema = z.object({
  version: z.literal(MCP_STORE_VERSION),
  servers: z.array(McpServerSchema),
});

type McpStorePayload = z.infer<typeof McpStorePayloadSchema>;

function createDefaultPayload(): McpStorePayload {
  return { version: MCP_STORE_VERSION, servers: [] };
}

function clonePayload(payload: McpStorePayload): McpStorePayload {
  return McpStorePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function nowMs(): number {
  return Date.now();
}

export class McpStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private payload: McpStorePayload = createDefaultPayload();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "mcp.json");
    this.logger = options.logger.child({ module: "mcp-store" });
  }

  list(): McpServer[] {
    this.ensureLoaded();
    return clonePayload(this.payload).servers;
  }

  get(id: string): McpServer | null {
    this.ensureLoaded();
    return this.payload.servers.find((server) => server.id === id) ?? null;
  }

  create(input: McpServerCreateInput): McpServer {
    this.ensureLoaded();
    const parsed = McpServerCreateInputSchema.parse(input);
    const timestamp = nowMs();
    const server = McpServerSchema.parse({
      id: randomUUID(),
      name: parsed.name,
      description: parsed.description,
      enabled: parsed.enabled ?? true,
      transport: parsed.transport,
      tools: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      originalJson: parsed.originalJson ?? "{}",
    });
    this.replaceAndPersist({ ...this.payload, servers: [...this.payload.servers, server] });
    return server;
  }

  update(input: McpServerUpdateInput): McpServer | null {
    this.ensureLoaded();
    const parsed = McpServerUpdateInputSchema.parse(input);
    const index = this.payload.servers.findIndex((server) => server.id === parsed.id);
    if (index < 0) return null;
    const current = this.payload.servers[index]!;
    const server = McpServerSchema.parse({
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.transport !== undefined ? { transport: parsed.transport } : {}),
      ...(parsed.originalJson !== undefined ? { originalJson: parsed.originalJson } : {}),
      updatedAt: nowMs(),
    });
    const servers = [...this.payload.servers];
    servers[index] = server;
    this.replaceAndPersist({ ...this.payload, servers });
    return server;
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const servers = this.payload.servers.filter((server) => server.id !== id);
    if (servers.length === this.payload.servers.length) return false;
    this.replaceAndPersist({ ...this.payload, servers });
    return true;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    if (!existsSync(this.filePath)) {
      this.payload = createDefaultPayload();
      this.loaded = true;
      return;
    }
    ensurePrivateFile(this.filePath);
    const raw = readFileSync(this.filePath, "utf8");
    try {
      this.payload = McpStorePayloadSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to parse MCP store");
      throw error;
    }
    this.loaded = true;
  }

  private replaceAndPersist(payload: McpStorePayload): void {
    const parsed = McpStorePayloadSchema.parse(payload);
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(parsed, null, 2));
    this.payload = parsed;
    this.loaded = true;
  }
}
