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

const DATABASE_NAME = "paseo-plugin-catalog-cache";
const STORE_NAME = "catalogs";
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE_NAME);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  return databasePromise;
}

export async function readCachedPluginCatalog(
  serverId: string,
): Promise<CachedPluginCatalogEntry[] | null> {
  if (!isStableServerId(serverId)) return null;
  try {
    const database = await openDatabase();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(serverId);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    return typeof raw === "string" ? parseCachedPluginCatalog(raw) : null;
  } catch (error) {
    console.warn(`[Plugins] Failed to read catalog cache for ${serverId}`, error);
    return null;
  }
}

export async function writeCachedPluginCatalog(
  serverId: string,
  entries: readonly CachedPluginCatalogEntry[],
): Promise<void> {
  if (!isStableServerId(serverId)) return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(serializeCachedPluginCatalog(entries), serverId);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } catch (error) {
    console.warn(`[Plugins] Failed to write catalog cache for ${serverId}`, error);
  }
}
