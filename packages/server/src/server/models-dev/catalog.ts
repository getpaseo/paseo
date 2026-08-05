const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export interface ModelsDevLookupHit {
  found: true;
  query: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  providerId: string;
}

export interface ModelsDevLookupMiss {
  found: false;
  query: string;
  error?: string;
}

export type ModelsDevLookupResult = ModelsDevLookupHit | ModelsDevLookupMiss;

interface ModelsDevIndexEntry {
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
}

interface ModelsDevCatalogCache {
  fetchedAtMs: number;
  entries: ModelsDevIndexEntry[];
  byExactId: Map<string, ModelsDevIndexEntry[]>;
  byLowerId: Map<string, ModelsDevIndexEntry[]>;
  bySuffix: Map<string, ModelsDevIndexEntry[]>;
}

export interface ModelsDevCatalogOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  apiUrl?: string;
}

let cache: ModelsDevCatalogCache | null = null;
let inflight: Promise<ModelsDevCatalogCache> | null = null;

export function resetModelsDevCatalogCacheForTests(): void {
  cache = null;
  inflight = null;
}

export function lookupModelsDevModelInCatalog(
  catalog: ModelsDevCatalogCache,
  query: string,
): ModelsDevLookupResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { found: false, query: "" };
  }

  const exact = pickBestEntry(catalog.byExactId.get(trimmed));
  if (exact) {
    return toHit(trimmed, exact);
  }

  const caseInsensitive = pickBestEntry(catalog.byLowerId.get(trimmed.toLowerCase()));
  if (caseInsensitive) {
    return toHit(trimmed, caseInsensitive);
  }

  const suffixKey = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const suffixMatches = pickBestEntry(catalog.bySuffix.get(suffixKey.toLowerCase()));
  if (suffixMatches) {
    return toHit(trimmed, suffixMatches);
  }

  return { found: false, query: trimmed };
}

export async function lookupModelsDevModel(
  query: string,
  options: ModelsDevCatalogOptions = {},
): Promise<ModelsDevLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { found: false, query: "" };
  }

  try {
    const catalog = await loadModelsDevCatalog(options);
    return lookupModelsDevModelInCatalog(catalog, trimmed);
  } catch (error) {
    return {
      found: false,
      query: trimmed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildModelsDevCatalogIndex(payload: unknown): ModelsDevCatalogCache {
  const entries: ModelsDevIndexEntry[] = [];
  if (!isRecord(payload)) {
    return indexEntries(entries, Date.now());
  }

  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue)) {
      continue;
    }
    const models = providerValue.models;
    if (!isRecord(models)) {
      continue;
    }
    for (const [modelKey, modelValue] of Object.entries(models)) {
      if (!isRecord(modelValue)) {
        continue;
      }
      const limit = isRecord(modelValue.limit) ? modelValue.limit : null;
      const context = limit?.context;
      if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
        continue;
      }
      const matchedId =
        typeof modelValue.id === "string" && modelValue.id.trim().length > 0
          ? modelValue.id.trim()
          : modelKey;
      const name =
        typeof modelValue.name === "string" && modelValue.name.trim().length > 0
          ? modelValue.name.trim()
          : undefined;
      entries.push({
        providerId,
        matchedId,
        ...(name ? { name } : {}),
        contextWindowMaxTokens: Math.trunc(context),
      });
    }
  }

  return indexEntries(entries, Date.now());
}

async function loadModelsDevCatalog(
  options: ModelsDevCatalogOptions,
): Promise<ModelsDevCatalogCache> {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const current = cache;
  if (current && now() - current.fetchedAtMs <= cacheTtlMs) {
    return current;
  }

  if (inflight) {
    return inflight;
  }

  inflight = fetchAndIndexCatalog(options)
    .then((next) => {
      cache = next;
      return next;
    })
    .catch((error) => {
      if (cache) {
        return cache;
      }
      throw error;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

async function fetchAndIndexCatalog(
  options: ModelsDevCatalogOptions,
): Promise<ModelsDevCatalogCache> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const apiUrl = options.apiUrl ?? MODELS_DEV_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`models.dev fetch failed: HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    const indexed = buildModelsDevCatalogIndex(payload);
    return {
      ...indexed,
      fetchedAtMs: (options.now ?? Date.now)(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function indexEntries(entries: ModelsDevIndexEntry[], fetchedAtMs: number): ModelsDevCatalogCache {
  const byExactId = new Map<string, ModelsDevIndexEntry[]>();
  const byLowerId = new Map<string, ModelsDevIndexEntry[]>();
  const bySuffix = new Map<string, ModelsDevIndexEntry[]>();

  for (const entry of entries) {
    pushMap(byExactId, entry.matchedId, entry);
    pushMap(byLowerId, entry.matchedId.toLowerCase(), entry);
    const suffix = entry.matchedId.includes("/")
      ? entry.matchedId.slice(entry.matchedId.lastIndexOf("/") + 1)
      : entry.matchedId;
    pushMap(bySuffix, suffix.toLowerCase(), entry);
  }

  return { fetchedAtMs, entries, byExactId, byLowerId, bySuffix };
}

function pushMap(
  map: Map<string, ModelsDevIndexEntry[]>,
  key: string,
  entry: ModelsDevIndexEntry,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(entry);
    return;
  }
  map.set(key, [entry]);
}

function pickBestEntry(entries: ModelsDevIndexEntry[] | undefined): ModelsDevIndexEntry | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return entries[0] ?? null;
  }
  return [...entries].sort((a, b) => {
    const providerCmp = a.providerId.localeCompare(b.providerId);
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return a.matchedId.localeCompare(b.matchedId);
  })[0]!;
}

function toHit(query: string, entry: ModelsDevIndexEntry): ModelsDevLookupHit {
  return {
    found: true,
    query,
    matchedId: entry.matchedId,
    ...(entry.name ? { name: entry.name } : {}),
    contextWindowMaxTokens: entry.contextWindowMaxTokens,
    providerId: entry.providerId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
