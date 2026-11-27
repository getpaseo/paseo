import {
  isStableServerId,
  parseCachedPluginCatalog,
  serializeCachedPluginCatalog,
  type CachedPluginCatalogEntry,
} from "./catalog-cache-format";
import type { CatalogCacheStorage } from "./catalog-cache-storage";

const CACHE_DIRECTORY = "plugin-catalogs";

function catalogFile(serverId: string): string {
  return `${CACHE_DIRECTORY}/${encodeURIComponent(serverId)}.json`;
}

export async function readFileCachedPluginCatalog(
  serverId: string,
  storage: CatalogCacheStorage,
): Promise<CachedPluginCatalogEntry[] | null> {
  if (!isStableServerId(serverId)) return null;
  let raw: string | null;
  try {
    raw = await storage.readTextFile(catalogFile(serverId));
  } catch (error) {
    // The next launch still loads from the daemon. A cache miss only costs this download.
    console.warn(`[Plugins] Failed to read catalog cache for ${serverId}`, error);
    return null;
  }
  return raw === null ? null : parseCachedPluginCatalog(raw);
}

export async function writeFileCachedPluginCatalog(
  serverId: string,
  entries: readonly CachedPluginCatalogEntry[],
  storage: CatalogCacheStorage,
): Promise<void> {
  if (!isStableServerId(serverId)) return;
  try {
    await storage.makeDirectory(CACHE_DIRECTORY);
    await storage.writeTextFile(catalogFile(serverId), serializeCachedPluginCatalog(entries));
  } catch (error) {
    console.warn(`[Plugins] Failed to write catalog cache for ${serverId}`, error);
  }
}
