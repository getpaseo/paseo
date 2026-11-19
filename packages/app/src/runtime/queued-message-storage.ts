import { z } from "zod";
import type { ComposerAttachment } from "@/attachments/types";
import type { QueuedComposerMessage } from "@/composer/actions";

export interface QueuedMessageStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const QUEUED_MESSAGES_KEY_PREFIX = "queued-composer-messages:";

const StoredQueuedMessageSchema = z.strictObject({
  id: z.string().min(1),
  queuedAt: z.number().optional(),
  text: z.string(),
  // Composer attachments are JSON by contract: binary image/file data lives in the
  // attachment stores and the queued message keeps only metadata and references.
  attachments: z.array(z.json()),
});
const StoredQueuedMessagesSchema = z.record(z.string(), z.array(StoredQueuedMessageSchema));

function storageKey(serverId: string): string {
  return `${QUEUED_MESSAGES_KEY_PREFIX}${encodeURIComponent(serverId)}`;
}

const storageTails = new WeakMap<object, Map<string, Promise<void>>>();

function enqueueStorageOperation<T>(
  storage: QueuedMessageStorage,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const tails = storageTails.get(storage) ?? new Map<string, Promise<void>>();
  storageTails.set(storage, tails);
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  tails.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

export async function readQueuedMessages(
  storage: QueuedMessageStorage,
  serverId: string,
): Promise<Map<string, QueuedComposerMessage[]>> {
  const key = storageKey(serverId);
  return enqueueStorageOperation(storage, key, async () => {
    const raw = await storage.getItem(key);
    if (raw === null) return new Map();

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      await storage.removeItem(key);
      return new Map();
    }

    const parsed = StoredQueuedMessagesSchema.safeParse(decoded);
    if (!parsed.success) {
      await storage.removeItem(key);
      return new Map();
    }

    return new Map(
      Object.entries(parsed.data).map(([agentId, messages]) => [
        agentId,
        messages.map((message) => ({
          ...message,
          attachments: message.attachments as ComposerAttachment[],
        })),
      ]),
    );
  });
}

export async function writeQueuedMessages(
  storage: QueuedMessageStorage,
  serverId: string,
  queues: ReadonlyMap<string, readonly QueuedComposerMessage[]>,
): Promise<void> {
  const value = Object.fromEntries(
    [...queues.entries()]
      .filter(([, messages]) => messages.length > 0)
      .map(([agentId, messages]) => [agentId, messages]),
  );
  const key = storageKey(serverId);
  await enqueueStorageOperation(storage, key, async () => {
    if (Object.keys(value).length === 0) {
      await storage.removeItem(key);
      return;
    }
    await storage.setItem(key, JSON.stringify(value));
  });
}
