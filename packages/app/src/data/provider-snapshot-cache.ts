import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  expandProviderSnapshot,
  type CompactProviderSnapshot,
} from "@getpaseo/protocol/provider-snapshot-codec";
import { CompactProviderSnapshotSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

const CACHE_VERSION = 1;
const CACHE_KEY_PREFIX = "@paseo/provider-snapshot/v1";
const CACHE_INDEX_KEY = "@paseo/provider-snapshot-index/v1";
const CACHE_INDEX_VERSION = 1;
const DEFAULT_MAX_CACHE_BYTES = 4 * 1024 * 1024;

interface ProviderSnapshotStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<ReadonlyArray<readonly [string, string | null]>>;
  multiRemove(keys: readonly string[]): Promise<void>;
}

interface ProviderSnapshotCacheOptions {
  maxBytes?: number;
}

interface StoredProviderSnapshot {
  version: typeof CACHE_VERSION;
  hash: string;
  generatedAt: string;
  compactSnapshot: CompactProviderSnapshot;
}

interface ProviderSnapshotIndexEntry {
  key: string;
  bytes: number;
  writtenAt: string;
}

interface ProviderSnapshotIndex {
  version: typeof CACHE_INDEX_VERSION;
  entries: ProviderSnapshotIndexEntry[];
}

const StoredProviderSnapshotSchema: z.ZodType<StoredProviderSnapshot> = z.strictObject({
  version: z.literal(CACHE_VERSION),
  hash: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  compactSnapshot: CompactProviderSnapshotSchema,
});

export interface CachedProviderSnapshot extends StoredProviderSnapshot {
  entries: ProviderSnapshotEntry[];
}

export interface ProviderSnapshotCache {
  read(serverId: string, cwd: string | null): Promise<CachedProviderSnapshot | null>;
  write(input: {
    serverId: string;
    cwd: string | null;
    hash: string;
    generatedAt: string;
    compactSnapshot: CompactProviderSnapshot;
  }): Promise<void>;
}

export class ProviderSnapshotCacheMissError extends Error {
  constructor() {
    super("Daemon returned not-modified without a cached provider snapshot");
    this.name = "ProviderSnapshotCacheMissError";
  }
}

function cacheKey(serverId: string, cwd: string | null): string {
  return `${CACHE_KEY_PREFIX}:${JSON.stringify([serverId, cwd])}`;
}

function storedBytes(key: string, value: string): number {
  return Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
}

function oldestFirst(left: ProviderSnapshotIndexEntry, right: ProviderSnapshotIndexEntry): number {
  const writtenAtOrder = left.writtenAt.localeCompare(right.writtenAt);
  return writtenAtOrder !== 0 ? writtenAtOrder : left.key.localeCompare(right.key);
}

function parseStoredProviderSnapshot(value: string): StoredProviderSnapshot | null {
  const parsed: unknown = JSON.parse(value);
  const result = StoredProviderSnapshotSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function createProviderSnapshotCache(
  storage: ProviderSnapshotStorage,
  options: ProviderSnapshotCacheOptions = {},
): ProviderSnapshotCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
  let index: ProviderSnapshotIndex | null = null;
  let operationQueue = Promise.resolve();

  async function persistIndex(entries: ProviderSnapshotIndexEntry[]): Promise<void> {
    const nextIndex: ProviderSnapshotIndex = { version: CACHE_INDEX_VERSION, entries };
    await storage.setItem(CACHE_INDEX_KEY, JSON.stringify(nextIndex));
    index = nextIndex;
  }

  async function reconcileCache(): Promise<void> {
    const keys = (await storage.getAllKeys()).filter((key) =>
      key.startsWith(`${CACHE_KEY_PREFIX}:`),
    );
    const values = await storage.multiGet(keys);
    const keysToRemove: string[] = [];
    const entries: ProviderSnapshotIndexEntry[] = [];
    for (const [key, value] of values) {
      if (value === null) continue;
      try {
        const stored = parseStoredProviderSnapshot(value);
        if (!stored) {
          keysToRemove.push(key);
          continue;
        }
        entries.push({ key, bytes: storedBytes(key, value), writtenAt: stored.generatedAt });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
        keysToRemove.push(key);
      }
    }

    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const retainedEntries = [...entries].sort(oldestFirst);
    while (totalBytes > maxBytes) {
      const evicted = retainedEntries.shift();
      if (!evicted) break;
      totalBytes -= evicted.bytes;
      keysToRemove.push(evicted.key);
    }
    if (keysToRemove.length > 0) await storage.multiRemove(keysToRemove);
    await persistIndex(retainedEntries);
  }

  async function ensureCacheIndex(): Promise<ProviderSnapshotIndex> {
    if (index === null) await reconcileCache();
    if (index === null) throw new Error("Provider snapshot cache reconciliation failed");
    return index;
  }

  async function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => {
        index = null;
      },
    );
    return result;
  }

  async function writeSnapshot(input: {
    serverId: string;
    cwd: string | null;
    hash: string;
    generatedAt: string;
    compactSnapshot: CompactProviderSnapshot;
  }): Promise<void> {
    const currentIndex = await ensureCacheIndex();
    const key = cacheKey(input.serverId, input.cwd);
    const stored = StoredProviderSnapshotSchema.safeParse({
      version: CACHE_VERSION,
      hash: input.hash,
      generatedAt: input.generatedAt,
      compactSnapshot: input.compactSnapshot,
    });
    if (!stored.success) {
      await storage.removeItem(key);
      await persistIndex(currentIndex.entries.filter((entry) => entry.key !== key));
      return;
    }
    const value = JSON.stringify(stored.data);
    const incomingBytes = storedBytes(key, value);
    const canStoreIncoming = incomingBytes <= maxBytes;
    const retainedEntries = currentIndex.entries.filter((entry) => entry.key !== key);
    let projectedBytes = retainedEntries.reduce((total, entry) => total + entry.bytes, 0);
    if (canStoreIncoming) projectedBytes += incomingBytes;

    const keysToRemove: string[] = [];
    for (const candidate of [...retainedEntries].sort(oldestFirst)) {
      if (projectedBytes <= maxBytes) break;
      projectedBytes -= candidate.bytes;
      keysToRemove.push(candidate.key);
    }
    const removedKeys = new Set(keysToRemove);
    const nextEntries = retainedEntries.filter((entry) => !removedKeys.has(entry.key));

    if (!canStoreIncoming && currentIndex.entries.some((entry) => entry.key === key)) {
      keysToRemove.push(key);
    }
    if (keysToRemove.length > 0) await storage.multiRemove(keysToRemove);
    if (canStoreIncoming) {
      await storage.setItem(key, value);
      nextEntries.push({ key, bytes: incomingBytes, writtenAt: input.generatedAt });
    }
    await persistIndex(nextEntries);
  }

  return {
    async read(serverId, cwd) {
      try {
        return await runSerialized(async () => {
          const currentIndex = await ensureCacheIndex();
          const key = cacheKey(serverId, cwd);
          const value = await storage.getItem(key);
          if (value === null) return null;
          try {
            const stored = parseStoredProviderSnapshot(value);
            if (!stored) throw new SyntaxError("Invalid provider snapshot");
            return { ...stored, entries: expandProviderSnapshot(stored.compactSnapshot) };
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
            await storage.removeItem(key);
            await persistIndex(currentIndex.entries.filter((entry) => entry.key !== key));
            return null;
          }
        });
      } catch (error) {
        if (error instanceof Error) return null;
        throw error;
      }
    },
    async write(input) {
      try {
        await runSerialized(() => writeSnapshot(input));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    },
  };
}

export const providerSnapshotCache = createProviderSnapshotCache(AsyncStorage);
