import { env, waitUntil } from "cloudflare:workers";

export const GITHUB_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedValue<T> {
  fetchedAt: number;
  value: T;
}

type Validator<T> = (value: unknown) => value is T;

function getWebsiteCache(): KVNamespace | null {
  return (env as { WEBSITE_CACHE?: KVNamespace }).WEBSITE_CACHE ?? null;
}

function isCachedValue<T>(value: unknown, isValue: Validator<T>): value is CachedValue<T> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.fetchedAt === "number" && isValue(record.value);
}

async function readCachedValue<T>(
  key: string,
  isValue: Validator<T>,
): Promise<CachedValue<T> | null> {
  const cache = getWebsiteCache();
  if (!cache) return null;
  const cached = await cache.get(key, { cacheTtl: 60, type: "json" });
  return isCachedValue(cached, isValue) ? cached : null;
}

async function writeCachedValue<T>(key: string, value: T): Promise<void> {
  const cache = getWebsiteCache();
  if (!cache) return;
  await cache.put(
    key,
    JSON.stringify({
      fetchedAt: Date.now(),
      value,
    }),
  );
}

export async function getBlockingColdCache<T>({
  key,
  isValue,
  fetchFresh,
}: {
  key: string;
  isValue: Validator<T>;
  fetchFresh: () => Promise<T>;
}): Promise<T> {
  const cached = await readCachedValue(key, isValue);
  if (cached) {
    if (Date.now() - cached.fetchedAt > GITHUB_CACHE_TTL_MS) {
      waitUntil(
        fetchFresh()
          .then((fresh) => writeCachedValue(key, fresh))
          .catch(() => undefined),
      );
    }
    return cached.value;
  }

  const fresh = await fetchFresh();
  await writeCachedValue(key, fresh);
  return fresh;
}
