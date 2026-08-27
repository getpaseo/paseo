import AsyncStorage from "@react-native-async-storage/async-storage";

const RECEIPT_LIMIT = 256;
const STORAGE_KEY_PREFIX = "plugin-notification-receipts";

export interface PluginNotificationReceiptStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PluginNotificationReceiptScope {
  serverId: string;
  pluginId: string;
  sourceId: string;
}

function storageKey(scope: PluginNotificationReceiptScope): string {
  return [STORAGE_KEY_PREFIX, scope.serverId, scope.pluginId, scope.sourceId]
    .map(encodeURIComponent)
    .join(":");
}

function parseReceipts(serialized: string | null): string[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .slice(-RECEIPT_LIMIT);
  } catch {
    return [];
  }
}

export class PluginNotificationReceiptStore {
  private readonly receipts = new Map<string, string[]>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly storage: PluginNotificationReceiptStorage) {}

  claim(scope: PluginNotificationReceiptScope, eventIds: readonly string[]): Promise<string[]> {
    const key = storageKey(scope);
    const previous = this.operations.get(key) ?? Promise.resolve();
    const operation = previous.then(() => this.claimAfterPrevious(key, eventIds));
    this.operations.set(
      key,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  private async claimAfterPrevious(key: string, eventIds: readonly string[]): Promise<string[]> {
    let receipts = this.receipts.get(key);
    if (!receipts) {
      receipts = parseReceipts(await this.storage.getItem(key));
    }

    const seen = new Set(receipts);
    const claimed: string[] = [];
    for (const eventId of eventIds) {
      if (seen.has(eventId)) continue;
      seen.add(eventId);
      claimed.push(eventId);
    }
    if (claimed.length === 0) {
      this.receipts.set(key, receipts);
      return [];
    }

    const nextReceipts = [...receipts, ...claimed].slice(-RECEIPT_LIMIT);
    this.receipts.set(key, nextReceipts);
    try {
      await this.storage.setItem(key, JSON.stringify(nextReceipts));
    } catch (error) {
      console.warn("[Plugins] Failed to persist notification receipts", error);
    }
    return claimed;
  }
}

export const pluginNotificationReceiptStore = new PluginNotificationReceiptStore(AsyncStorage);
