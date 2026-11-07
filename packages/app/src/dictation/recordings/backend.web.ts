import type { DictationRecording, DictationRecordingBackend } from "./types";

const DB_NAME = "paseo-dictation-recordings";
const DB_VERSION = 1;
const METADATA_STORE = "metadata";
const AUDIO_STORE = "audio";

interface AudioRecord {
  id: string;
  segments: string[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error("IndexedDB is unavailable in this runtime."));
      return;
    }
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Failed to open dictation recordings IndexedDB.")),
    );
  });
}

function run<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const request = operation(transaction);
    transaction.addEventListener("complete", () => resolve(request?.result));
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
    );
  });
}

export function createDictationRecordingBackend(): DictationRecordingBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    dbPromise ??= openDb().catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  return {
    async listMetadata() {
      const result = await run<DictationRecording[]>(
        await db(),
        [METADATA_STORE],
        "readonly",
        (transaction) => transaction.objectStore(METADATA_STORE).getAll(),
      );
      return result ?? [];
    },
    async writeMetadata(recording) {
      await run(await db(), [METADATA_STORE], "readwrite", (transaction) =>
        transaction.objectStore(METADATA_STORE).put(recording),
      );
    },
    async writeSegments(id, segments) {
      const record: AudioRecord = { id, segments };
      await run(await db(), [AUDIO_STORE], "readwrite", (transaction) =>
        transaction.objectStore(AUDIO_STORE).put(record),
      );
    },
    async readSegments(id) {
      const record = await run<AudioRecord | undefined>(
        await db(),
        [AUDIO_STORE],
        "readonly",
        (transaction) => transaction.objectStore(AUDIO_STORE).get(id),
      );
      return record?.segments ?? null;
    },
    async remove(id) {
      await run(await db(), [METADATA_STORE, AUDIO_STORE], "readwrite", (transaction) => {
        transaction.objectStore(METADATA_STORE).delete(id);
        transaction.objectStore(AUDIO_STORE).delete(id);
        return null;
      });
    },
  };
}
