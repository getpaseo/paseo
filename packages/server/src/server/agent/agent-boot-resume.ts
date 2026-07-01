import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";

export interface ResumeInterruptedAgentsDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

function wasInterrupted(record: StoredAgentRecord): boolean {
  if (record.archivedAt || record.internal || !record.persistence) {
    return false;
  }
  if (record.interruptedAt) {
    return true;
  }
  // No marker but a live-looking status means the previous daemon never ran
  // its graceful close pass — i.e. it crashed mid-run.
  return record.lastStatus === "running" || record.lastStatus === "initializing";
}

export async function resumeInterruptedAgents(deps: ResumeInterruptedAgentsDeps): Promise<void> {
  const { agentManager, agentStorage, logger } = deps;
  const records = await agentStorage.list();
  const interrupted = records.filter(wasInterrupted);
  if (interrupted.length === 0) {
    return;
  }

  logger.info(
    { count: interrupted.length },
    "Resuming agents interrupted by the previous daemon shutdown",
  );

  for (const record of interrupted) {
    try {
      await ensureAgentLoaded(record.id, { agentManager, agentStorage, logger });
      logger.info(
        { agentId: record.id, provider: record.provider },
        "Interrupted agent resumed on boot",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, agentId: record.id }, "Failed to resume interrupted agent");
      // ensureAgentLoaded persists a fresh snapshot only on success, so clear
      // the marker explicitly to avoid retrying this agent on every boot.
      const current = await agentStorage.get(record.id);
      if (current) {
        await agentStorage.upsert({ ...current, interruptedAt: null, lastError: message });
      }
    }
  }
}
