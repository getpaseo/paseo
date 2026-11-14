import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { z } from "zod";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import { AttachmentMetadataSchema } from "@/stores/draft-store/state";

const STORAGE_KEY = "paseo-message-outbox-v1";

const OutboxItemSchema = z.strictObject({
  id: z.string(),
  serverId: z.string(),
  agentId: z.string(),
  text: z.string(),
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

export function hydrateOutbox(): Promise<void> {
  hydration ??= (async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      useOutboxStore.setState({ hydrated: true });
      return;
    }
    const parsed = StoredOutboxSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("Saved outbox is invalid; it was left untouched.");
    // A send interrupted by app termination has an unknown outcome. Never auto-retry it.
    const items = parsed.data.items;
    for (const item of items) {
      if (item.status === "sending") item.status = "needs_review";
    }
    useOutboxStore.setState({ items, hydrated: true });
  })().catch((error) => {
    hydration = null;
    throw error;
  });
  return hydration;
}

function mutateItems(transform: (items: OutboxItem[]) => OutboxItem[]): Promise<void> {
  const next = mutation
    .catch(() => undefined)
    .then(async () => {
      await hydrateOutbox();
      const items = transform(useOutboxStore.getState().items);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items }));
      useOutboxStore.setState({ items });
      return undefined;
    });
  mutation = next;
  return next;
}

export function enqueueOutboxItem(item: OutboxItem): Promise<void> {
  return mutateItems((items) => [...items, item]);
}

export function updateOutboxItem(
  id: string,
  update: (item: OutboxItem) => OutboxItem,
): Promise<void> {
  return mutateItems((items) => items.map((item) => (item.id === id ? update(item) : item)));
}

export function removeOutboxItem(id: string): Promise<void> {
  return mutateItems((items) => items.filter((item) => item.id !== id));
}

export function discardOutboxItem(id: string): Promise<void> {
  return mutateItems((items) =>
    items.filter((item) => item.id !== id || item.status === "sending"),
  );
}

export function getOutboxImageIds(): ReadonlySet<string> {
  return new Set(useOutboxStore.getState().items.flatMap((item) => item.images.map((i) => i.id)));
}

export function createPendingOutboxItem(input: {
  id: string;
  serverId: string;
  agentId: string;
  text: string;
  activeTurnBehavior?: "interrupt" | "steer";
  activeTurnId?: string;
  images: AttachmentMetadata[];
  attachments: OutboxItem["attachments"];
}): OutboxItem {
  return { ...input, status: "pending", createdAt: Date.now() };
}
