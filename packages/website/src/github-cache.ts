export const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;

export interface WebsiteCacheContext {
  cache: KVNamespace | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

interface CachedValue<T> {
  fetchedAt: number;
  value: T;
}

type Validator<T> = (value: unknown) => value is T;

function isCachedValue<T>(value: unknown, isValue: Validator<T>): value is CachedValue<T> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.fetchedAt === "number" && isValue(record.value);
}

async function readCachedValue<T>(
  cache: KVNamespace | null,
  key: string,
  isValue: Validator<T>,
): Promise<CachedValue<T> | null> {
  if (!cache) return null;
  const cached = await cache.get(key, { cacheTtl: 60, type: "json" });
  return isCachedValue(cached, isValue) ? cached : null;
}

async function writeCachedValue<T>(
  cache: KVNamespace | null,
  key: string,
  value: T,
): Promise<void> {
  if (!cache) return;
  await cache.put(
    key,
    JSON.stringify({
      fetchedAt: Date.now(),
      value,
    }),
  );
}

interface CacheOptions<T> {
  context: WebsiteCacheContext;
  key: string;
  isValue: Validator<T>;
  fetchFresh: () => Promise<T>;
}

function refreshInBackground<T>({ context, key, fetchFresh }: CacheOptions<T>): void {
  context.waitUntil(
    fetchFresh()
      .then((fresh) => writeCachedValue(context.cache, key, fresh))
      .catch(() => undefined),
  );
}

/** Return the cached value, warming the cache in the background when it is empty or stale. */
export async function getNonBlockingColdCache<T>(options: CacheOptions<T>): Promise<T | null> {
  const { context, key, isValue } = options;
  if (!context.cache) return null;
  const cached = await readCachedValue(context.cache, key, isValue);
  if (!cached || Date.now() - cached.fetchedAt > GITHUB_CACHE_TTL_MS) {
    refreshInBackground(options);
  }
  return cached?.value ?? null;
}

export async function getBlockingColdCache<T>(options: CacheOptions<T>): Promise<T> {
  const { context, key, isValue, fetchFresh } = options;
  const cached = await readCachedValue(context.cache, key, isValue);
  if (cached) {
    if (Date.now() - cached.fetchedAt > GITHUB_CACHE_TTL_MS) {
      refreshInBackground(options);
    }
    return cached.value;
  }

  const fresh = await fetchFresh();
  await writeCachedValue(context.cache, key, fresh);
  return fresh;
}
