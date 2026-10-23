import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentMessageDelivery } from "./agent-messages/index.js";
import { formatFinishNotificationBody } from "./agent-prompt.js";

export const INTERRUPTED_TURN_ERROR = "Daemon restarted before the active turn completed.";

export async function recoverInterruptedAgentRecords(
  storage: AgentStorage,
  logger: Logger,
  interruptedRecords?: readonly StoredAgentRecord[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  for (const interrupted of interruptedRecords ?? (await storage.list())) {
    if (interrupted.lastStatus !== "running" && interrupted.lastStatus !== "initializing") continue;
    const record = await storage.get(interrupted.id);
    if (!record) continue;
    if (record.archivedAt) {
      await storage.upsert({ ...record, lastStatus: "closed", finishNotifications: [] });
      continue;
    }
    await storage.upsert({
      ...record,
      lastStatus: "error",
      lastError: INTERRUPTED_TURN_ERROR,
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: timestamp,
      finishNotifications: interrupted.finishNotifications?.map((notification) =>
        Object.assign({}, notification, { interruptedAt: timestamp }),
      ),
    });
    logger.warn(
      { agentId: record.id, provider: record.provider },
      "Agent turn interrupted by daemon restart",
    );
  }
}

/** Keep an interrupted callback until its recipient acknowledges provider dispatch. */
export async function deliverInterruptedFinishNotifications(params: {
  storage: AgentStorage;
  agentMessages: AgentMessageDelivery;
  logger: Logger;
}): Promise<void> {
  const { storage, agentMessages, logger } = params;
  const deliveries: Promise<void>[] = [];
  for (const record of await storage.list()) {
    for (const notification of record.finishNotifications ?? []) {
      if (!notification.interruptedAt) continue;
      const caller = await storage.get(notification.callerAgentId);
      if (
        !caller ||
        caller.archivedAt ||
        record.archivedAt ||
        (notification.requireParentOwnership &&
          getParentAgentIdFromLabels(record.labels) !== caller.id)
      ) {
        await storage.removeFinishNotification(record.id, notification.id, {
          includeInterrupted: true,
        });
        continue;
      }
      const receipt = agentMessages.enqueue({
        messageId: notification.id,
        recipientId: caller.id,
        prompt:
          formatFinishNotificationBody({
            childAgentId: record.id,
            title: record.title ?? record.id,
            serverId: notification.childServerId,
            reason: "errored",
            lastAssistantMessage: null,
          }) +
          "\n\n" +
          INTERRUPTED_TURN_ERROR,
        source: {
          kind: "agent-notification",
          agentId: record.id,
          serverId: notification.childServerId,
          title: record.title ?? record.id,
          event: "errored",
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      });
      deliveries.push(
        receipt.dispatched.then(
          () =>
            storage.removeFinishNotification(record.id, notification.id, {
              includeInterrupted: true,
            }),
          (err) => {
            logger.error(
              { err, agentId: record.id, callerAgentId: caller.id },
              "Interrupted turn notification remains pending",
            );
          },
        ),
      );
    }
  }
  await Promise.all(deliveries);
}
