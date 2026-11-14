import type { AttachmentMetadata } from "@/attachments/types";
import type { ComposerSendClient } from "@/composer/actions";
import { createUserMessage } from "@/types/stream";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { encodeImages } from "@/utils/encode-images";
import { removeOutboxItem, updateOutboxItem, useOutboxStore, type OutboxItem } from "./store";

const inFlight = new Set<string>();
const drains = new Set<string>();

export async function deliverOutboxItem(input: {
  item: OutboxItem;
  client: Pick<ComposerSendClient, "sendAgentMessage">;
  encode?: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
}): Promise<void> {
  const { item, client } = input;
  if (inFlight.has(item.id)) return;
  inFlight.add(item.id);
  try {
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      status: "sending",
      error: undefined,
    }));
    if (!useOutboxStore.getState().items.some((current) => current.id === item.id)) return;
    const submission = createMessageSubmissionWriter(item.serverId);
    submission.begin(
      item.agentId,
      createUserMessage({
        clientMessageId: item.id,
        text: item.text,
        timestamp: new Date(item.createdAt),
        images: item.images,
        attachments: item.attachments,
        ...(item.activeTurnBehavior === "steer" && item.activeTurnId
          ? { turnId: item.activeTurnId }
          : {}),
      }),
    );
    try {
      const images = (await (input.encode ?? encodeImages)(item.images)) ?? [];
      await client.sendAgentMessage(item.agentId, item.text, {
        messageId: item.id,
        ...(item.activeTurnBehavior ? { activeTurnBehavior: item.activeTurnBehavior } : {}),
        images,
        attachments: item.attachments,
      });
      submission.accept(item.agentId, item.id);
      await removeOutboxItem(item.id);
    } catch (error) {
      submission.reject(item.agentId, item.id);
      throw error;
    }
  } catch (error) {
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      status: "needs_review",
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    inFlight.delete(item.id);
  }
}

export async function drainPendingOutbox(input: {
  serverId: string;
  client: Pick<ComposerSendClient, "sendAgentMessage">;
}): Promise<void> {
  if (drains.has(input.serverId)) return;
  drains.add(input.serverId);
  try {
    while (true) {
      const next = useOutboxStore
        .getState()
        .items.find(
          (item) =>
            item.serverId === input.serverId && item.status === "pending" && !inFlight.has(item.id),
        );
      if (!next) break;
      await deliverOutboxItem({ item: next, client: input.client });
    }
  } finally {
    drains.delete(input.serverId);
  }
}
