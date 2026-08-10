const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export interface ModelsDevCandidate {
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
}

export interface ModelsDevLookupHit {
  found: true;
  query: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
  providerId: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  candidates: ModelsDevCandidate[];
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
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
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

  const suffixKey = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const matches = [
    ...(catalog.byExactId.get(trimmed) ?? []),
    ...(catalog.byLowerId.get(trimmed.toLowerCase()) ?? []),
    ...(catalog.bySuffix.get(suffixKey.toLowerCase()) ?? []),
  ];
  if (matches.length === 0) {
    return { found: false, query: trimmed };
  }
  return toHit(trimmed, matches);
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
      const entry = parseModelsDevModelEntry(providerId, modelKey, modelValue);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return indexEntries(entries, Date.now());
}

function parseModelsDevModelEntry(
  providerId: string,
  modelKey: string,
  modelValue: unknown,
): ModelsDevIndexEntry | null {
  if (!isRecord(modelValue)) {
    return null;
  }
  const limit = isRecord(modelValue.limit) ? modelValue.limit : null;
  const context = limit?.context;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return null;
  }

  const matchedId =
    typeof modelValue.id === "string" && modelValue.id.trim().length > 0
      ? modelValue.id.trim()
      : modelKey;
  const name =
    typeof modelValue.name === "string" && modelValue.name.trim().length > 0
      ? modelValue.name.trim()
      : undefined;
  const maxOutput = readPositiveInt(limit?.output);
  const modalities = isRecord(modelValue.modalities) ? modelValue.modalities : null;
  const inputModalities = readStringList(modalities?.input);
  const outputModalities = readStringList(modalities?.output);
  const capabilities = deriveCapabilities(modelValue);

  return {
    providerId,
    matchedId,
    ...(name ? { name } : {}),
    contextWindowMaxTokens: Math.trunc(context),
    ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
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

function sortEntries(entries: ModelsDevIndexEntry[]): ModelsDevIndexEntry[] {
  return [...entries].sort((a, b) => {
    const providerCmp = a.providerId.localeCompare(b.providerId);
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return a.matchedId.localeCompare(b.matchedId);
  });
}

function dedupeEntries(entries: ModelsDevIndexEntry[]): ModelsDevIndexEntry[] {
  const seen = new Set<string>();
  const result: ModelsDevIndexEntry[] = [];
  for (const entry of sortEntries(entries)) {
    const key = `${entry.providerId}\0${entry.matchedId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function toCandidate(entry: ModelsDevIndexEntry): ModelsDevCandidate {
  return {
    providerId: entry.providerId,
    matchedId: entry.matchedId,
    ...(entry.name ? { name: entry.name } : {}),
    contextWindowMaxTokens: entry.contextWindowMaxTokens,
    ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(entry.inputModalities ? { inputModalities: entry.inputModalities } : {}),
    ...(entry.outputModalities ? { outputModalities: entry.outputModalities } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
  };
}

function toHit(query: string, entries: ModelsDevIndexEntry[]): ModelsDevLookupHit {
  const candidates = dedupeEntries(entries).map(toCandidate);
  const best = candidates[0];
  if (!best) {
    return {
      found: true,
      query,
      matchedId: query,
      contextWindowMaxTokens: 1,
      providerId: "unknown",
      candidates: [],
    };
  }
  return {
    found: true,
    query,
    matchedId: best.matchedId,
    ...(best.name ? { name: best.name } : {}),
    contextWindowMaxTokens: best.contextWindowMaxTokens,
    ...(best.maxOutputTokens !== undefined ? { maxOutputTokens: best.maxOutputTokens } : {}),
    providerId: best.providerId,
    ...(best.inputModalities ? { inputModalities: best.inputModalities } : {}),
    ...(best.outputModalities ? { outputModalities: best.outputModalities } : {}),
    ...(best.capabilities ? { capabilities: best.capabilities } : {}),
    candidates,
  };
}

function deriveCapabilities(modelValue: Record<string, unknown>): string[] | undefined {
  const capabilities: string[] = [];
  if (modelValue.tool_call === true) {
    capabilities.push("tools");
  }
  if (modelValue.reasoning === true) {
    capabilities.push("reasoning");
  }
  if (modelValue.structured_output === true) {
    capabilities.push("structured");
  }
  if (modelValue.temperature === true) {
    capabilities.push("temperature");
  }
  if (modelValue.attachment === true) {
    capabilities.push("attachment");
  }
  if (modelValue.interleaved === true) {
    capabilities.push("interleaved");
  }
  // Some providers nest open_weights/knowledge differently; ignore unknowns.
  return capabilities.length > 0 ? capabilities : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
