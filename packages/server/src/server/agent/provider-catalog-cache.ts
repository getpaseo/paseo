import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import type { AgentMode, AgentModelDefinition } from "./agent-sdk-types.js";

const CACHE_VERSION = 1 as const;
const MAX_CACHE_ENTRIES = 64;

const AgentSelectOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const AgentModelDefinitionSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    aliases: z.array(z.string()).optional(),
    isSelectable: z.boolean().optional(),
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    contextWindowMaxTokens: z.number().optional(),
    thinkingOptions: z.array(AgentSelectOptionSchema).optional(),
    defaultThinkingOptionId: z.string().optional(),
  })
  .passthrough();

const AgentModeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    colorTier: z.string().optional(),
    isUnattended: z.boolean().optional(),
  })
  .passthrough();

const PersistedEntrySchema = z
  .object({
    fetchedAt: z.string(),
    binaryFingerprint: z.string().optional(),
    catalog: z
      .object({
        models: z.array(AgentModelDefinitionSchema),
        modes: z.array(AgentModeSchema),
        defaultModeId: z.string().nullable().optional(),
      })
      .strip(),
  })
  .strip();

const PersistedProviderCatalogCacheSchema = z
  .object({
    version: z.literal(CACHE_VERSION),
    entries: z.record(z.string(), z.record(z.string(), PersistedEntrySchema)),
  })
  .strip();

export interface PersistedProviderCatalogEntry {
  fetchedAt: string;
  binaryFingerprint?: string;
  catalog: {
    models: AgentModelDefinition[];
    modes: AgentMode[];
    defaultModeId?: string | null;
  };
}

/**
 * Best-effort daemon-side disk cache for provider model/mode catalogs.
 * Loads asynchronously without blocking the daemon event loop and writes atomically
 * (temp file + rename) serialized on a single lane.
 */
export class ProviderCatalogCache {
  private readonly entries = new Map<string, Map<string, PersistedProviderCatalogEntry>>();
  private readonly deletedProviders = new Set<string>();
  private readonly writtenKeys = new Map<string, Set<string>>();
  private readonly ready: Promise<void>;
  private writeLane: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {
    this.ready = this.loadFromDisk();
  }

  async get(provider: string, key: string): Promise<PersistedProviderCatalogEntry | undefined> {
    await this.ready;
    const entry = this.entries.get(provider)?.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  set(provider: string, key: string, entry: PersistedProviderCatalogEntry): void {
    this.deletedProviders.delete(provider);
    let keys = this.writtenKeys.get(provider);
    if (!keys) {
      keys = new Set();
      this.writtenKeys.set(provider, keys);
    }
    keys.add(key);

    let providerEntries = this.entries.get(provider);
    if (!providerEntries) {
      providerEntries = new Map();
      this.entries.set(provider, providerEntries);
    }
    providerEntries.set(key, structuredClone(entry));
    this.prune();
    this.scheduleWrite();
  }

  deleteProvider(provider: string): void {
    this.deletedProviders.add(provider);
    this.writtenKeys.delete(provider);
    this.entries.delete(provider);
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writeLane;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.logger.warn(
          { err: error, filePath: this.filePath },
          "Failed to read provider catalog cache; starting empty",
        );
      }
      return;
    }

    try {
      const parsed = PersistedProviderCatalogCacheSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn(
          { filePath: this.filePath, issues: parsed.error.issues.length },
          "Ignoring invalid provider catalog cache",
        );
        return;
      }
      for (const [provider, byKey] of Object.entries(parsed.data.entries)) {
        if (this.deletedProviders.has(provider)) continue;
        const written = this.writtenKeys.get(provider);
        let map = this.entries.get(provider);
        for (const [key, value] of Object.entries(byKey)) {
          if (written?.has(key)) continue;
          if (!map) {
            map = new Map();
            this.entries.set(provider, map);
          }
          map.set(key, value as PersistedProviderCatalogEntry);
        }
      }
      this.prune();
    } catch (error) {
      this.logger.warn(
        { err: error, filePath: this.filePath },
        "Failed to parse provider catalog cache; starting empty",
      );
    }
  }

  private prune(): void {
    const all: Array<{ provider: string; key: string; fetchedAtMs: number }> = [];
    for (const [provider, byKey] of this.entries) {
      for (const [key, entry] of byKey) {
        const parsedMs = Date.parse(entry.fetchedAt);
        all.push({
          provider,
          key,
          fetchedAtMs: Number.isFinite(parsedMs) ? parsedMs : 0,
        });
      }
    }
    if (all.length <= MAX_CACHE_ENTRIES) return;
    all.sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
    const excess = all.length - MAX_CACHE_ENTRIES;
    for (let index = 0; index < excess; index += 1) {
      const target = all[index]!;
      const byKey = this.entries.get(target.provider);
      byKey?.delete(target.key);
      if (byKey && byKey.size === 0) this.entries.delete(target.provider);
    }
  }

  private snapshotJson(): string {
    const entries: Record<string, Record<string, PersistedProviderCatalogEntry>> = {};
    for (const [provider, byKey] of this.entries) {
      if (byKey.size === 0) continue;
      entries[provider] = Object.fromEntries(byKey.entries());
    }
    return `${JSON.stringify({ version: CACHE_VERSION, entries }, null, 2)}\n`;
  }

  private scheduleWrite(): void {
    this.writeLane = this.writeLane
      .then(() => this.ready)
      .then(() => this.writeAtomically(this.snapshotJson()))
      .catch((error) => {
        this.logger.warn(
          { err: error, filePath: this.filePath },
          "Failed to persist provider catalog cache",
        );
      });
  }

  private async writeAtomically(payload: string): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}
