import AsyncStorage from "@react-native-async-storage/async-storage";

const CLIENT_ID_STORAGE_KEY = "@paseo:client-id-v1";

export interface ClientIdStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface ClientIdResolver {
  getOrCreate(): Promise<string>;
}

function normalizeStoredClientId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createClientIdResolver(deps: {
  storage: ClientIdStorage;
  generateUuid: () => string;
  storageKey?: string;
}): ClientIdResolver {
  const storageKey = deps.storageKey ?? CLIENT_ID_STORAGE_KEY;
  let cached: string | null = null;
  let inFlight: Promise<string> | null = null;

  return {
    async getOrCreate(): Promise<string> {
      if (cached) {
        return cached;
      }
      if (inFlight) {
        return inFlight;
      }

      inFlight = (async () => {
        const stored = await deps.storage.getItem(storageKey);
        const existing = normalizeStoredClientId(stored);
        if (existing) {
          cached = existing;
          return existing;
        }

        const next = `cid_${deps.generateUuid()}`;
        await deps.storage.setItem(storageKey, next);
        cached = next;
        return next;
      })();

      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}

function generateUuidFromGlobalCrypto(): string {
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const defaultResolver = createClientIdResolver({
  storage: AsyncStorage,
  generateUuid: generateUuidFromGlobalCrypto,
});

export async function getOrCreateClientId(): Promise<string> {
  return defaultResolver.getOrCreate();
}
