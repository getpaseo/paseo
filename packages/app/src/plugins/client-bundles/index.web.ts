import { createPluginClientBundleStore } from "./store";

const DATABASE_NAME = "paseo-plugin-client-bundles";
const STORE_NAME = "bundles";
let opening: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

export function createHostPluginClientBundleStore(serverId: string) {
  const prefix = `${encodeURIComponent(serverId)}/`;
  const range = () => IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  async function run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.addEventListener("complete", () => resolve(request.result));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  }
  return createPluginClientBundleStore(
    {
      async list() {
        return (await run("readonly", (store) => store.getAllKeys(range())))
          .filter((key): key is string => typeof key === "string")
          .map((key) => key.slice(prefix.length));
      },
      async read(name) {
        const result: unknown = await run("readonly", (store) => store.get(`${prefix}${name}`));
        if (typeof result !== "string") throw new Error("Missing plugin client bundle");
        return result;
      },
      async writeAtomic(name, contents) {
        await run("readwrite", (store) => store.put(contents, `${prefix}${name}`));
      },
      async remove(name) {
        await run("readwrite", (store) => store.delete(`${prefix}${name}`));
      },
    },
    async (contents) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
  );
}
