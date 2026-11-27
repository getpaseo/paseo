import { readFileCachedPluginCatalog, writeFileCachedPluginCatalog } from "./catalog-cache-file";
import type { CachedPluginCatalogEntry } from "./catalog-cache-format";
import { createExpoCatalogCacheStorage } from "./catalog-cache-storage";
export {
  parseCachedPluginCatalog,
  serializeCachedPluginCatalog,
  type CachedPluginCatalogEntry,
} from "./catalog-cache-format";

const storage = createExpoCatalogCacheStorage();

export function readCachedPluginCatalog(
  serverId: string,
): Promise<CachedPluginCatalogEntry[] | null> {
  return readFileCachedPluginCatalog(serverId, storage);
}

export function writeCachedPluginCatalog(
  serverId: string,
  entries: readonly CachedPluginCatalogEntry[],
): Promise<void> {
  return writeFileCachedPluginCatalog(serverId, entries, storage);
}
