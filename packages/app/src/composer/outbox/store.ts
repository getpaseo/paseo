import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { z } from "zod";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import { AttachmentMetadataSchema } from "@/stores/draft-store/state";

const STORAGE_KEY = "paseo-message-outbox-v1";
const ITEM_PREFIX = "paseo-message-outbox-item-v1:";
const ownedSending = new Set<string>();
const itemKey = (id: string) => `${ITEM_PREFIX}${encodeURIComponent(id)}`;

const OutboxItemSchema = z.strictObject({
  id: z.string(),
  serverId: z.string(),
  agentId: z.string(),
  text: z.string(),
  sendBehavior: z.enum(["queue", "interrupt", "steer"]).optional(),
  activeTurnBehavior: z.enum(["interrupt", "steer"]).optional(),
  activeTurnId: z.string().optional(),
  images: z.array(AttachmentMetadataSchema),
  attachments: z.array(AgentAttachmentSchema),
  status: z.enum(["pending", "sending", "needs_review"]),
  createdAt: z.number(),
  error: z.string().optional(),
});
const StoredOutboxSchema = z.strictObject({
  version: z.literal(1),
  items: z.array(OutboxItemSchema),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

interface OutboxState {
  items: OutboxItem[];
  hydrated: boolean;
}

export const useOutboxStore = create<OutboxState>(() => ({ items: [], hydrated: false }));
let hydration: Promise<void> | null = null;
let mutation: Promise<unknown> = Promise.resolve();

async function readItems(): Promise<OutboxItem[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(ITEM_PREFIX));
  const entries = await AsyncStorage.multiGet(keys);
  return entries
    .flatMap(([, raw]) => {
      if (!raw) return [];
      const item = OutboxItemSchema.parse(JSON.parse(raw));
      if (item.status === "sending" && !ownedSending.has(item.id)) item.status = "needs_review";
      return [item];
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function hydrateOutbox(): Promise<void> {
  hydration ??= (async () => {
    const legacy = await AsyncStorage.getItem(STORAGE_KEY);
    if (legacy) {
      const parsed = StoredOutboxSchema.parse(JSON.parse(legacy));
      for (const item of parsed.items) {
        if ((await AsyncStorage.getItem(itemKey(item.id))) === null) {
          await AsyncStorage.setItem(itemKey(item.id), JSON.stringify(item));
        }
      }
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
    useOutboxStore.setState({ items: await readItems(), hydrated: true });
  })().catch((error) => {
    hydration = null;
    throw error;
  });
  return hydration;
}

function mutateItem(operation: () => Promise<void>): Promise<void> {
  const next = mutation
    .catch(() => undefined)
    .then(async () => {
      await hydrateOutbox();
      await operation();
      const previous = new Map(useOutboxStore.getState().items.map((item) => [item.id, item]));
      const items = (await readItems()).map((item) => {
        const old = previous.get(item.id);
        return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
      });
      useOutboxStore.setState({ items });
      return undefined;
    });
  mutation = next;
  return next;
}

export function enqueueOutboxItem(item: OutboxItem): Promise<void> {
  // Separate keys prevent one window's cached array from replacing another window's messages.
  return mutateItem(() => AsyncStorage.setItem(itemKey(item.id), JSON.stringify(item)));
}

export function updateOutboxItem(
  id: string,
  update: (item: OutboxItem) => OutboxItem,
): Promise<void> {
  return mutateItem(async () => {
    const raw = await AsyncStorage.getItem(itemKey(id));
    if (!raw) return;
    const item = update(OutboxItemSchema.parse(JSON.parse(raw)));
    if (item.status === "sending") ownedSending.add(id);
    else ownedSending.delete(id);
    await AsyncStorage.setItem(itemKey(id), JSON.stringify(item));
  });
}

export function removeOutboxItem(id: string): Promise<void> {
  return mutateItem(async () => {
    await AsyncStorage.removeItem(itemKey(id));
    ownedSending.delete(id);
  });
}

export function discardOutboxItem(id: string): Promise<void> {
  return mutateItem(async () => {
    const raw = await AsyncStorage.getItem(itemKey(id));
    if (
      !raw ||
      (OutboxItemSchema.parse(JSON.parse(raw)).status === "sending" && ownedSending.has(id))
    )
      return;
    await AsyncStorage.removeItem(itemKey(id));
  });
}

export function getOutboxImageIds(): ReadonlySet<string> {
  return new Set(useOutboxStore.getState().items.flatMap((item) => item.images.map((i) => i.id)));
}

export function createPendingOutboxItem(input: {
  id: string;
  serverId: string;
  agentId: string;
  text: string;
  sendBehavior?: "queue" | "interrupt" | "steer";
  activeTurnBehavior?: "interrupt" | "steer";
  activeTurnId?: string;
  images: AttachmentMetadata[];
  attachments: OutboxItem["attachments"];
}): OutboxItem {
  return { ...input, status: "pending", createdAt: Date.now() };
}
