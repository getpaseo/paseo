import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import type { AttachmentMetadata } from "@/attachments/types";
import type { ComposerSendClient } from "@/composer/actions";
import { createUserMessage } from "@/types/stream";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { encodeImages } from "@/utils/encode-images";
import { removeOutboxItem, updateOutboxItem, useOutboxStore, type OutboxItem } from "./store";

export type OutboxDeliveryClient = Pick<ComposerSendClient, "sendAgentMessage"> &
  Partial<Pick<DaemonClient, "getAgentMessageDeliveryStatus">> & {
    readonly isConnected: boolean;
    fetchAgent(agentId: string): Promise<{
      agent: Pick<AgentSnapshotPayload, "status" | "activeTurn">;
    } | null>;
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
  if (
    !timeline.some(
      (row) =>
        row.kind === "user_message" &&
        (row.clientMessageId === item.id || row.messageId === item.id),
    )
  ) {
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
  }
  return submission;
}

function requestOptions(item: OutboxItem) {
  return {
    messageId: item.id,
    ...(item.activeTurnBehavior ? { activeTurnBehavior: item.activeTurnBehavior } : {}),
    images: item.wireImages ?? [],
    attachments: item.attachments,
  };
}

function definitelyUnsent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "deliveryOutcome" in error &&
    (error.deliveryOutcome === "not_submitted" || error.deliveryOutcome === "rejected")
  );
}

async function readyToDeliver(item: OutboxItem, client: OutboxDeliveryClient): Promise<boolean> {
  if (item.sendBehavior && item.sendBehavior !== "queue") return client.isConnected;
  const current = await client.fetchAgent(item.agentId);
  return (
    client.isConnected &&
    current !== null &&
    current.agent.status !== "running" &&
    !current.agent.activeTurn
  );
}

/** Reads evidence only. Neither a missing row nor an unknown receipt authorizes resending. */
export async function checkOutboxItem(input: {
  item: OutboxItem;
  client: OutboxDeliveryClient;
}): Promise<void> {
  const { item, client } = input;
  if (inFlight.has(item.id) || !client.isConnected) return;
  inFlight.add(item.id);
  try {
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      status: "checking",
      error: undefined,
    }));
    if (!client.getAgentMessageDeliveryStatus)
      throw new Error("Update the Paseo host to check message delivery status.");
    // New attempts retain the exact wire images. Legacy interrupted attempts may lack them.
    if (!item.wireImages && item.images.length)
      throw new Error(
        "Delivery is unconfirmed. The original image payload is unavailable; check the conversation.",
      );
    const result = await client.getAgentMessageDeliveryStatus({
      agentId: item.agentId,
      text: item.text,
      ...requestOptions(item),
    });
    if (result.status === "accepted") {
      createMessageSubmissionWriter(item.serverId).accept(item.agentId, item.id);
      await removeOutboxItem(item.id);
    } else {
      const checks = (item.statusChecks ?? 0) + 1;
      let status: OutboxItem["status"] = "needs_review";
      if (result.status === "rejected") status = "failed";
      else if (result.status === "in_flight" && checks < 30) status = "in_flight";
      await updateOutboxItem(item.id, (current) => ({
        ...current,
        status,
        statusChecks: checks,
        error: result.failure?.message,
      }));
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

export async function deliverOutboxItem(input: {
  item: OutboxItem;
  client: OutboxDeliveryClient;
  encode?: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
}): Promise<boolean> {
  const { client } = input;
  // Read current persisted state so a stale Retry closure cannot resubmit an uncertain attempt.
  const storedItem = useOutboxStore
    .getState()
    .items.find((current) => current.id === input.item.id);
  if (!storedItem) return false;
  let item: OutboxItem = storedItem;
  if (item.status === "needs_review" || item.status === "in_flight") {
    await checkOutboxItem({ item, client });
    return false;
  }
  const agentKey = `${item.serverId}:${item.agentId}`;
  if (inFlight.has(item.id) || activeAgents.has(agentKey) || !client.isConnected) return false;
  inFlight.add(item.id);
  activeAgents.add(agentKey);
  let invoked = false;
  let submission: ReturnType<typeof createMessageSubmissionWriter> | undefined;
  try {
    if (!(await readyToDeliver(item, client))) {
      await updateOutboxItem(item.id, (current) => ({
        ...current,
        status: "pending",
        error: undefined,
      }));
      return false;
    }
    const images = item.wireImages ?? (await (input.encode ?? encodeImages)(item.images)) ?? [];
    // Persist the exact payload before any network effect, so recovery can verify its fingerprint.
    item = { ...item, wireImages: images };
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      wireImages: images,
      status: "sending",
      error: undefined,
    }));
    if (!useOutboxStore.getState().items.some((current) => current.id === item.id)) return false;
    if (!client.isConnected) {
      await updateOutboxItem(item.id, (current) => ({ ...current, status: "pending" }));
      return false;
    }
    submission = beginOutboxSubmission(item);
    invoked = true;
    await client.sendAgentMessage(item.agentId, item.text, requestOptions(item));
    submission.accept(item.agentId, item.id);
    await removeOutboxItem(item.id);
  } catch (error) {
    const failed = !invoked || definitelyUnsent(error);
    if (failed) submission?.reject(item.agentId, item.id);
    else submission?.release?.(item.agentId, item.id);
    await updateOutboxItem(item.id, (current) => ({
      ...current,
      status: failed ? "failed" : "needs_review",
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    inFlight.delete(item.id);
    activeAgents.delete(agentKey);
  }
  await checkLatestUncertainItem(item.id, client);
  return true;
}

async function checkLatestUncertainItem(id: string, client: OutboxDeliveryClient): Promise<void> {
  const latest = useOutboxStore.getState().items.find((current) => current.id === id);
  if (
    latest?.status === "needs_review" &&
    client.isConnected &&
    client.getAgentMessageDeliveryStatus
  )
    await checkOutboxItem({ item: latest, client });
}

export async function drainPendingOutbox(input: {
  serverId: string;
  client: OutboxDeliveryClient;
  checkUnknown?: boolean;
}): Promise<void> {
  if (drains.has(input.serverId)) return;
  drains.add(input.serverId);
  try {
    // On reconnect, reconcile uncertain attempts before considering new pending messages.
    const uncertain = useOutboxStore
      .getState()
      .items.filter(
        (item) =>
          item.serverId === input.serverId &&
          (item.status === "in_flight" ||
            (input.checkUnknown !== false && item.status === "needs_review")),
      );
    for (const item of uncertain) await checkOutboxItem({ item, client: input.client });
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
