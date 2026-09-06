import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  expandProviderSnapshot,
  type CompactProviderSnapshot,
} from "@getpaseo/protocol/provider-snapshot-codec";
import { CompactProviderSnapshotSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { GetProvidersSnapshotResponseMessage } from "@getpaseo/protocol/messages";
type SnapshotPayload = GetProvidersSnapshotResponseMessage["payload"];

const CACHE_VERSION = 2;
const CACHE_KEY_PREFIX = "@paseo/provider-snapshot/v2";
const CACHE_INDEX_KEY = "@paseo/provider-snapshot-index/v2";
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
  compactSnapshot?: CompactProviderSnapshot;
  fetchedAt?: Record<string, string>;
}

interface ProviderSnapshotIndexEntry {
  key: string;
  bytes: number;
  writtenAt: string;
}

const StoredProviderSnapshotSchema: z.ZodType<StoredProviderSnapshot> = z.strictObject({
  version: z.literal(CACHE_VERSION),
  hash: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  compactSnapshot: CompactProviderSnapshotSchema.optional(),
  fetchedAt: z.record(z.string(), z.string()).optional(),
});

export interface CachedProviderSnapshot extends StoredProviderSnapshot {
  compactSnapshot: CompactProviderSnapshot;
  entries: ProviderSnapshotEntry[];
}

export interface ProviderSnapshotCache {
  read(serverId: string, cwd: string | null): Promise<CachedProviderSnapshot | null>;
  readHash(serverId: string, hash: string): Promise<CachedProviderSnapshot | null>;
  materialize(serverId: string, snapshot: SnapshotPayload): Promise<SnapshotPayload>;
  write(input: {
    serverId: string;
    cwd: string | null;
    hash: string;
    generatedAt: string;
    compactSnapshot: CompactProviderSnapshot;
    fetchedAt?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<void>;
}

export class ProviderSnapshotCacheMissError extends Error {
  constructor() {
    super("Daemon returned not-modified without a cached provider snapshot");
    this.name = "ProviderSnapshotCacheMissError";
  }
}

function cacheKey(serverId: string, cwd: string | null): string {
  return `${CACHE_KEY_PREFIX}:${JSON.stringify([serverId, "cwd", cwd])}`;
}

function bodyKey(serverId: string, hash: string): string {
  return `${CACHE_KEY_PREFIX}:${JSON.stringify([serverId, "hash", hash])}`;
}

function storedBytes(key: string, value: string): number {
  return Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
}

const CacheKeySchema = z.tuple([z.string(), z.enum(["cwd", "hash"]), z.string().nullable()]);

function decodeCacheKey(key: string) {
  return CacheKeySchema.parse(JSON.parse(key.slice(CACHE_KEY_PREFIX.length + 1)));
}

function oldestFirst(left: ProviderSnapshotIndexEntry, right: ProviderSnapshotIndexEntry): number {
  const writtenAtOrder = left.writtenAt.localeCompare(right.writtenAt);
  if (writtenAtOrder !== 0) return writtenAtOrder;
  // References must be evicted before equally recent bodies, regardless of key encoding.
  const leftKind = decodeCacheKey(left.key)[1];
  const rightKind = decodeCacheKey(right.key)[1];
  if (leftKind !== rightKind) return leftKind === "cwd" ? -1 : 1;
  return left.key.localeCompare(right.key);
}

function parseStoredProviderSnapshot(key: string, value: string): StoredProviderSnapshot | null {
  const parsed: unknown = JSON.parse(value);
  const result = StoredProviderSnapshotSchema.safeParse(parsed);
  if (!result.success) return null;
  const [, kind, identity] = decodeCacheKey(key);
  const stored = result.data;
  if (kind === "hash") return stored.compactSnapshot && identity === stored.hash ? stored : null;
  return stored.compactSnapshot ? null : stored;
}

export function createProviderSnapshotCache(
  storage: ProviderSnapshotStorage,
  options: ProviderSnapshotCacheOptions = {},
): ProviderSnapshotCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
  let index: ProviderSnapshotIndexEntry[] | null = null;
  let operationQueue = Promise.resolve();
  const bodies = new Map<string, CachedProviderSnapshot>();

  async function reconcileCache(): Promise<void> {
    const allKeys = await storage.getAllKeys();
    // COMPAT(providerSnapshotCache): added in v0.7.2, remove legacy cleanup after 2027-03-06.
    const legacyKeys = allKeys.filter(
      (key) =>
        key.startsWith("@paseo/provider-snapshot/v1:") ||
        key === "@paseo/provider-snapshot-index/v1" ||
        key === CACHE_INDEX_KEY,
    );
    if (legacyKeys.length) await storage.multiRemove(legacyKeys);
    const keys = allKeys.filter((key) => key.startsWith(`${CACHE_KEY_PREFIX}:`));
    const values = await storage.multiGet(keys);
    const keysToRemove: string[] = [];
    const entries: ProviderSnapshotIndexEntry[] = [];
    const references: Array<{ key: string; body: string; writtenAt: string }> = [];
    for (const [key, value] of values) {
      if (value === null) continue;
      try {
        const stored = parseStoredProviderSnapshot(key, value);
        if (!stored) {
          keysToRemove.push(key);
          continue;
        }
        const [serverId, kind] = decodeCacheKey(key);
        entries.push({ key, bytes: storedBytes(key, value), writtenAt: stored.generatedAt });
        if (kind === "cwd")
          references.push({
            key,
            body: bodyKey(serverId, stored.hash),
            writtenAt: stored.generatedAt,
          });
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof RangeError) &&
          !(error instanceof z.ZodError)
        )
          throw error;
        keysToRemove.push(key);
      }
    }

    // Reconstruct the dependency ordering before applying a possibly smaller budget.
    for (const reference of references) {
      const body = entries.find((entry) => entry.key === reference.body);
      if (!body) keysToRemove.push(reference.key);
      else if (body.writtenAt < reference.writtenAt) body.writtenAt = reference.writtenAt;
    }
    const retainedEntries = entries
      .filter((entry) => !keysToRemove.includes(entry.key))
      .sort(oldestFirst);
    let totalBytes = retainedEntries.reduce((total, entry) => total + entry.bytes, 0);
    while (totalBytes > maxBytes) {
      const evicted = retainedEntries.shift();
      if (!evicted) break;
      totalBytes -= evicted.bytes;
      keysToRemove.push(evicted.key);
    }
    if (keysToRemove.length > 0) {
      for (const removedKey of keysToRemove) bodies.delete(removedKey);
      await storage.multiRemove(keysToRemove);
    }
    index = retainedEntries;
  }

  async function ensureCacheIndex(): Promise<ProviderSnapshotIndexEntry[]> {
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

  async function writeRecord(
    key: string,
    input: StoredProviderSnapshot,
    requiredBody?: { key: string; input: StoredProviderSnapshot },
  ): Promise<void> {
    const currentIndex = await ensureCacheIndex();
    function prepare(recordKey: string, record: StoredProviderSnapshot) {
      const value = JSON.stringify(record);
      return {
        key: recordKey,
        bytes: storedBytes(recordKey, value),
        writtenAt: record.generatedAt,
        value,
      };
    }
    const incoming = prepare(key, input);
    // The index is committed last: membership proves a body was stored. Reusing it
    // needs only its byte count, not another parse, expansion, or storage write.
    const body = requiredBody
      ? (currentIndex.find((entry) => entry.key === requiredBody.key) ??
        prepare(requiredBody.key, requiredBody.input))
      : undefined;
    let admitted: Array<ProviderSnapshotIndexEntry & { value?: string }> = body
      ? [body, incoming]
      : [incoming];
    if (admitted.reduce((bytes, entry) => bytes + entry.bytes, 0) > maxBytes) {
      admitted = body && body.bytes <= maxBytes ? [body] : [];
    } else if (body) {
      admitted = [
        {
          ...body,
          writtenAt: body.writtenAt > input.generatedAt ? body.writtenAt : input.generatedAt,
        },
        incoming,
      ];
    }
    const replacedKeys = new Set([key, ...(requiredBody ? [requiredBody.key] : [])]);
    const retainedEntries = currentIndex.filter((entry) => !replacedKeys.has(entry.key));
    let projectedBytes = [...retainedEntries, ...admitted].reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    const keysToRemove = [...replacedKeys].filter(
      (replaced) => !admitted.some((entry) => entry.key === replaced),
    );
    for (const candidate of [...retainedEntries].sort(oldestFirst)) {
      if (projectedBytes <= maxBytes) break;
      projectedBytes -= candidate.bytes;
      keysToRemove.push(candidate.key);
    }
    const removedKeys = new Set(keysToRemove);
    if (keysToRemove.length > 0) {
      for (const removedKey of keysToRemove) bodies.delete(removedKey);
      await storage.multiRemove(keysToRemove);
    }
    // Body, then reference, then in-memory index. A failed write can leave a reusable
    // orphan body; reconciliation never retains a reference without its body.
    for (const entry of admitted) {
      if (entry.value !== undefined) await storage.setItem(entry.key, entry.value);
    }
    index = [
      ...retainedEntries.filter((entry) => !removedKeys.has(entry.key)),
      ...admitted.map(({ key: recordKey, bytes, writtenAt }) => ({
        key: recordKey,
        bytes,
        writtenAt,
      })),
    ];
  }

  async function readRecord(key: string): Promise<StoredProviderSnapshot | null> {
    const currentIndex = await ensureCacheIndex();
    const value = await storage.getItem(key);
    if (value === null) return null;
    try {
      const stored = parseStoredProviderSnapshot(key, value);
      if (!stored) throw new SyntaxError("Invalid provider snapshot");
      return stored;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
      bodies.delete(key);
      await storage.removeItem(key);
      index = currentIndex.filter((entry) => entry.key !== key);
      return null;
    }
  }

  async function readBody(serverId: string, hash: string): Promise<CachedProviderSnapshot | null> {
    const key = bodyKey(serverId, hash);
    const resident = bodies.get(key);
    if (resident) return resident;
    const stored = await readRecord(key);
    if (!stored?.compactSnapshot) return null;
    try {
      const body = {
        ...stored,
        compactSnapshot: stored.compactSnapshot,
        entries: expandProviderSnapshot(stored.compactSnapshot),
      };
      bodies.set(key, body);
      return body;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      await storage.removeItem(key);
      index = null;
      return null;
    }
  }

  async function safely<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await runSerialized(operation);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      bodies.clear();
      return fallback;
    }
  }

  return {
    async materialize(serverId, snapshot) {
      const { snapshotHash: hash, compactSnapshot } = snapshot;
      if (!hash) return snapshot;
      let body = await safely(async () => {
        const cached = await readBody(serverId, hash);
        if (cached) return cached;
        if (!compactSnapshot) throw new ProviderSnapshotCacheMissError();
        await writeRecord(bodyKey(serverId, hash), {
          version: CACHE_VERSION,
          hash,
          generatedAt: snapshot.generatedAt,
          compactSnapshot,
        });
        return await readBody(serverId, hash);
      }, null);
      if (!body) {
        if (!compactSnapshot) throw new ProviderSnapshotCacheMissError();
        body = {
          version: CACHE_VERSION,
          hash,
          generatedAt: snapshot.generatedAt,
          compactSnapshot,
          entries: expandProviderSnapshot(compactSnapshot),
        };
      }
      return {
        ...snapshot,
        compactSnapshot: body.compactSnapshot,
        entries: snapshot.fetchedAt
          ? body.entries.map((entry) => ({
              ...entry,
              fetchedAt: snapshot.fetchedAt![entry.provider],
            }))
          : body.entries,
      };
    },
    readHash(serverId, hash) {
      return safely(() => readBody(serverId, hash), null);
    },
    read(serverId, cwd) {
      return safely(async () => {
        const association = await readRecord(cacheKey(serverId, cwd));
        if (!association) return null;
        const body = await readBody(serverId, association.hash);
        if (!body) {
          // Storage may be removed or corrupted outside this owner's write queue.
          await reconcileCache();
          return null;
        }
        return {
          ...body,
          ...association,
          compactSnapshot: body.compactSnapshot,
          entries: association.fetchedAt
            ? body.entries.map((entry) => ({
                ...entry,
                fetchedAt: association.fetchedAt![entry.provider],
              }))
            : body.entries,
        };
      }, null);
    },
    write(input) {
      return safely(async () => {
        if (input.signal?.aborted) return;
        await writeRecord(
          cacheKey(input.serverId, input.cwd),
          {
            version: CACHE_VERSION,
            hash: input.hash,
            generatedAt: input.generatedAt,
            fetchedAt: input.fetchedAt,
          },
          {
            key: bodyKey(input.serverId, input.hash),
            input: {
              version: CACHE_VERSION,
              hash: input.hash,
              generatedAt: input.generatedAt,
              compactSnapshot: input.compactSnapshot,
            },
          },
        );
      }, undefined);
    },
  };
}

export const providerSnapshotCache = createProviderSnapshotCache(AsyncStorage);
