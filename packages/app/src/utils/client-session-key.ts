import AsyncStorage from "@react-native-async-storage/async-storage";

const CLIENT_SESSION_KEY_STORAGE_KEY = "@paseo:client-session-key-v1";

let cachedClientSessionKey: string | null = null;
let inFlightClientSessionKey: Promise<string> | null = null;

function generateClientSessionKey(): string {
  const randomUuid = (() => {
    const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  })();
  return `clsk_${randomUuid}`;
}

function normalizeStoredClientSessionKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getOrCreateClientSessionKey(): Promise<string> {
  if (cachedClientSessionKey) {
    return cachedClientSessionKey;
  }
  if (inFlightClientSessionKey) {
    return inFlightClientSessionKey;
  }

  inFlightClientSessionKey = (async () => {
    const storedValue = await AsyncStorage.getItem(CLIENT_SESSION_KEY_STORAGE_KEY);
    const existing = normalizeStoredClientSessionKey(storedValue);
    if (existing) {
      cachedClientSessionKey = existing;
      return existing;
    }

    const nextValue = generateClientSessionKey();
    await AsyncStorage.setItem(CLIENT_SESSION_KEY_STORAGE_KEY, nextValue);
    cachedClientSessionKey = nextValue;
    return nextValue;
  })();

  try {
    return await inFlightClientSessionKey;
  } finally {
    inFlightClientSessionKey = null;
  }
}
