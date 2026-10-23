import type { Logger } from "pino";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

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
    // Hub executions have their own owner/recovery lifecycle and are closed on shutdown.
    if (record.archivedAt || record.owner) {
      await storage.upsert({ ...record, lastStatus: "closed" });
      continue;
    }
    await storage.upsert({
      ...record,
      lastStatus: "error",
      lastError: INTERRUPTED_TURN_ERROR,
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: timestamp,
    });
    logger.warn(
      { agentId: record.id, provider: record.provider },
      "Agent turn interrupted by daemon restart",
    );
  }
}
