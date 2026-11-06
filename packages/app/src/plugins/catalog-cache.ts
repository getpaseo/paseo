import { File, Paths } from "expo-file-system";
import {
  isStableServerId,
  parseCachedPluginCatalog,
  serializeCachedPluginCatalog,
  type CachedPluginCatalogEntry,
} from "./catalog-cache-format";
export {
  parseCachedPluginCatalog,
  serializeCachedPluginCatalog,
  type CachedPluginCatalogEntry,
} from "./catalog-cache-format";

function catalogFile(serverId: string): File {
  const name = `${serverId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  return new File(Paths.document, "plugin-catalogs", name);
}

export async function readCachedPluginCatalog(
  serverId: string,
): Promise<CachedPluginCatalogEntry[] | null> {
  if (!isStableServerId(serverId)) return null;
  let raw: string;
  try {
    const file = catalogFile(serverId);
    if (!file.exists) return null;
    raw = await file.text();
  } catch (error) {
    // The next launch still loads from the daemon. A cache miss only costs this download.
    console.warn(`[Plugins] Failed to read catalog cache for ${serverId}`, error);
    return null;
  }
  return parseCachedPluginCatalog(raw);
}

export async function writeCachedPluginCatalog(
  serverId: string,
  entries: readonly CachedPluginCatalogEntry[],
): Promise<void> {
  if (!isStableServerId(serverId)) return;
  try {
    const file = catalogFile(serverId);
    file.create({ intermediates: true, overwrite: true });
    file.write(serializeCachedPluginCatalog(entries));
  } catch (error) {
    console.warn(`[Plugins] Failed to write catalog cache for ${serverId}`, error);
  }
}
