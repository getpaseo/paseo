const CACHE_VERSION = 1;

export interface CachedPluginCatalogEntry {
  id: string;
  clientBundle: string;
  requirements?: { paseo?: string };
}

/**
 * `local:` is the stand-in host-runtime uses until the daemon reports its server id
 * and rekeys. A file stored under that stand-in is never read again.
 */
export function isStableServerId(serverId: string): boolean {
  return !serverId.startsWith("local:");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): CachedPluginCatalogEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.clientBundle !== "string") return null;
  if (value.requirements === undefined) {
    return { id: value.id, clientBundle: value.clientBundle };
  }
  if (!isRecord(value.requirements)) return null;
  const paseo = value.requirements.paseo;
  if (paseo !== undefined && typeof paseo !== "string") return null;
  return {
    id: value.id,
    clientBundle: value.clientBundle,
    requirements: paseo === undefined ? {} : { paseo },
  };
}

export function parseCachedPluginCatalog(raw: string): CachedPluginCatalogEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
    return null;
  }
  const entries: CachedPluginCatalogEntry[] = [];
  for (const entry of parsed.entries) {
    const parsedEntry = parseEntry(entry);
    if (!parsedEntry) return null;
    entries.push(parsedEntry);
  }
  return entries;
}

export function serializeCachedPluginCatalog(entries: readonly CachedPluginCatalogEntry[]): string {
  return JSON.stringify({ version: CACHE_VERSION, entries });
}
