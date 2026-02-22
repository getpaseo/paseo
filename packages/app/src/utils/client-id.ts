import AsyncStorage from "@react-native-async-storage/async-storage";

const CLIENT_ID_STORAGE_KEY = "@paseo:client-id-v1";

let cachedClientId: string | null = null;
let inFlightClientId: Promise<string> | null = null;

function generateClientId(): string {
  const randomUuid = (() => {
    const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  })();
  return `cid_${randomUuid}`;
}

function normalizeStoredClientId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getOrCreateClientId(): Promise<string> {
  if (cachedClientId) {
    return cachedClientId;
  }
  if (inFlightClientId) {
    return inFlightClientId;
  }

  inFlightClientId = (async () => {
    const storedValue = await AsyncStorage.getItem(CLIENT_ID_STORAGE_KEY);
    const existing = normalizeStoredClientId(storedValue);
    if (existing) {
      cachedClientId = existing;
      return existing;
    }

    const nextValue = generateClientId();
    await AsyncStorage.setItem(CLIENT_ID_STORAGE_KEY, nextValue);
    cachedClientId = nextValue;
    return nextValue;
  })();

  try {
    return await inFlightClientId;
  } finally {
    inFlightClientId = null;
  }
}
