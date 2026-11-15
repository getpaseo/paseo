import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import type { AttachmentMetadata } from "@/attachments/types";
import type { ComposerSendClient } from "@/composer/actions";
import { createUserMessage } from "@/types/stream";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { encodeImages } from "@/utils/encode-images";
import { removeOutboxItem, updateOutboxItem, useOutboxStore, type OutboxItem } from "./store";

export type OutboxDeliveryClient = Pick<ComposerSendClient, "sendAgentMessage"> & {
  readonly isConnected: boolean;
  fetchAgent(
    agentId: string,
  ): Promise<{ agent: Pick<AgentSnapshotPayload, "status" | "activeTurn"> } | null>;
};

const inFlight = new Set<string>();
const activeAgents = new Set<string>();
const drains = new Set<string>();

function beginOutboxSubmission(item: OutboxItem) {
  const submission = createMessageSubmissionWriter(item.serverId);
  const session = useSessionStore.getState().sessions[item.serverId];
  const timeline = [
    ...(session?.agentStreamTail.get(item.agentId) ?? []),
    ...(session?.agentStreamHead.get(item.agentId) ?? []),
  ];
  const alreadyPresent = timeline.some(
    (row) =>
      row.kind === "user_message" && (row.clientMessageId === item.id || row.messageId === item.id),
  );
  if (!alreadyPresent)
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
  return { submission, alreadyPresent };
}

async function readyToDeliver(item: OutboxItem, client: OutboxDeliveryClient): Promise<boolean> {
  if (item.sendBehavior && item.sendBehavior !== "queue") return client.isConnected;
  try {
    const current = await client.fetchAgent(item.agentId);
    return (
      client.isConnected &&
      current !== null &&
      current.agent.status !== "running" &&
      !current.agent.activeTurn
    );
  } catch {
    return false;
  }
}

export async function deliverOutboxItem(input: {
  item: OutboxItem;
  client: OutboxDeliveryClient;
  encode?: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
}): Promise<boolean> {
  const { item, client } = input;
  const agentKey = `${item.serverId}:${item.agentId}`;
  if (inFlight.has(item.id) || activeAgents.has(agentKey) || !client.isConnected) return false;
  inFlight.add(item.id);
  activeAgents.add(agentKey);
  try {
    if (!(await readyToDeliver(item, client))) return false;
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      status: "sending",
      error: undefined,
    }));
    if (!useOutboxStore.getState().items.some((current) => current.id === item.id)) return false;
    const { submission, alreadyPresent } = beginOutboxSubmission(item);
    try {
      const images = (await (input.encode ?? encodeImages)(item.images)) ?? [];
      if (!client.isConnected) {
        await updateOutboxItem(item.id, (current) => ({ ...current, status: "pending" }));
        if (!alreadyPresent) submission.reject(item.agentId, item.id);
        return false;
      }
      await client.sendAgentMessage(item.agentId, item.text, {
        messageId: item.id,
        ...(item.activeTurnBehavior ? { activeTurnBehavior: item.activeTurnBehavior } : {}),
        images,
        attachments: item.attachments,
      });
      submission.accept(item.agentId, item.id);
      await removeOutboxItem(item.id);
    } catch (error) {
      if (!alreadyPresent) submission.reject(item.agentId, item.id);
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
    activeAgents.delete(agentKey);
  }
  return true;
}

export async function drainPendingOutbox(input: {
  serverId: string;
  client: OutboxDeliveryClient;
}): Promise<void> {
  if (drains.has(input.serverId)) return;
  drains.add(input.serverId);
  try {
    const deferredAgents = new Set<string>();
    while (input.client.isConnected) {
      const next = useOutboxStore
        .getState()
        .items.find(
          (item) =>
            item.serverId === input.serverId &&
            item.status === "pending" &&
            !inFlight.has(item.id) &&
            !deferredAgents.has(item.agentId),
        );
      if (!next) break;
      const attempted = await deliverOutboxItem({ item: next, client: input.client });
      if (!attempted || !next.sendBehavior || next.sendBehavior === "queue")
        deferredAgents.add(next.agentId);
    }
  } finally {
    drains.delete(input.serverId);
  }
}
