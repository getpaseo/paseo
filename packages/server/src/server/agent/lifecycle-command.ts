import type { Logger } from "pino";

import type { ManagedAgent } from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";

export type LifecycleAgentSnapshot = Pick<ManagedAgent, "id" | "cwd" | "lifecycle">;

export interface LifecycleAgentManager {
  getAgent(agentId: string): LifecycleAgentSnapshot | null;
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(agentId: string): Promise<boolean>;
  clearAgentAttention(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
  archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord>;
  closeAgent(agentId: string): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  notifyAgentState(agentId: string): void;
  setAgentMode(agentId: string, modeId: string): Promise<void>;
  updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void>;
}

export interface LifecycleAgentStorage {
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
}

export interface AgentLifecycleCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  logger: Logger;
}

export interface CancelAgentRunResult {
  agent: LifecycleAgentSnapshot;
  cancelled: boolean;
}

export async function cancelAgentRunCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger">,
  agentId: string,
): Promise<CancelAgentRunResult> {
  const { agentManager, logger } = dependencies;
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    logger.trace({ agentId }, "cancelAgentRunCommand: agent not found");
    throw new Error(`Agent ${agentId} not found`);
  }

  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  if (!hasInFlightRun) {
    logger.trace(
      { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
      "cancelAgentRunCommand: skipping because agent is not running",
    );
    return { agent, cancelled: false };
  }

  logger.debug(
    { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
    "cancelAgentRunCommand: interrupting",
  );
  const startedAt = Date.now();
  const cancelled = await agentManager.cancelAgentRun(agentId);
  logger.debug(
    { agentId, cancelled, durationMs: Date.now() - startedAt },
    "cancelAgentRunCommand: cancelAgentRun completed",
  );

  if (!cancelled) {
    logger.warn(
      { agentId },
      "cancelAgentRunCommand: reported running but no active run was cancelled",
    );
  }

  return {
    agent,
    cancelled,
  };
}

export interface ArchiveAgentResult {
  agentId: string;
  archivedAt: string;
  record: StoredAgentRecord;
}

export async function archiveAgentCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
): Promise<ArchiveAgentResult> {
  const liveAgent = dependencies.agentManager.getAgent(agentId);
  let record: StoredAgentRecord | null;
  if (liveAgent) {
    await cancelAgentRunCommand(dependencies, agentId);
    await dependencies.agentManager.clearAgentAttention(agentId).catch(() => undefined);
    await dependencies.agentManager.archiveAgent(agentId);
    record = await dependencies.agentStorage.get(agentId);
  } else {
    record = await archiveStoredAgent(dependencies, agentId);
  }

  if (!record) {
    throw new Error(`Agent not found in storage after archive: ${agentId}`);
  }
  if (!record.archivedAt) {
    throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
  }

  return {
    agentId,
    archivedAt: record.archivedAt,
    record,
  };
}

export async function closeAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<void> {
  await dependencies.agentManager.closeAgent(agentId);
}

export interface UpdateAgentResult {
  accepted: boolean;
  error: string | null;
}

export async function updateAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    name?: string;
    labels?: Record<string, string>;
  },
): Promise<UpdateAgentResult> {
  const title = input.name?.trim();
  const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined;

  if (!title && !labels) {
    return {
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    };
  }

  await dependencies.agentManager.updateAgentMetadata(input.agentId, {
    ...(title ? { title } : {}),
    ...(labels ? { labels } : {}),
  });

  return {
    accepted: true,
    error: null,
  };
}

export async function setAgentModeCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    modeId: string;
  },
): Promise<{ modeId: string }> {
  await dependencies.agentManager.setAgentMode(input.agentId, input.modeId);
  return { modeId: input.modeId };
}

async function archiveStoredAgent(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage">,
  agentId: string,
): Promise<StoredAgentRecord> {
  const existing = await dependencies.agentStorage.get(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (existing.archivedAt) {
    return existing;
  }

  const archivedAt = new Date().toISOString();
  return dependencies.agentManager.archiveSnapshot(agentId, archivedAt);
}
