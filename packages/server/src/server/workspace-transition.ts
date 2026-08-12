import type { Logger } from "pino";

import type { AgentManager, ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

export interface CommitWorkspaceTransitionDependencies {
  agentManager: Pick<AgentManager, "closeAgent" | "relocateAgentForNextResume">;
  agentStorage: Pick<AgentStorage, "list" | "upsert">;
  workspaceRegistry: Pick<WorkspaceRegistry, "remove" | "update" | "upsert">;
  killWorkspaceTerminals: (workspaceId: string) => Promise<void>;
  emitWorkspaceUpdate: (workspaceId: string) => Promise<void>;
  logger: Pick<Logger, "warn">;
  schedule?: (callback: () => void) => void;
}

export interface CommitWorkspaceTransitionInput {
  caller: ManagedAgent;
  liveAgents: ManagedAgent[];
  sourceWorkspace: PersistedWorkspaceRecord;
  targetWorkspace: PersistedWorkspaceRecord;
  temporaryWorkspaceId: string;
}

export class WorkspaceTransitionPreservationRequiredError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      "Workspace transition rollback could not restore all persisted records; preserving the worktree",
      { cause: originalError },
    );
    this.name = "WorkspaceTransitionPreservationRequiredError";
    this.originalError = originalError;
  }
}

export function resolveWorkspaceTransitionBaseRef(input: {
  requestedBaseBranch?: string;
  currentBranch: string | null;
}): string {
  return input.requestedBaseBranch ?? input.currentBranch ?? "HEAD";
}

export async function commitWorkspaceTransition(
  dependencies: CommitWorkspaceTransitionDependencies,
  input: CommitWorkspaceTransitionInput,
): Promise<PersistedWorkspaceRecord> {
  const { sourceWorkspace, targetWorkspace } = input;

  await Promise.all(
    input.liveAgents
      .filter((agent) => agent.id !== input.caller.id)
      .map((agent) => dependencies.agentManager.closeAgent(agent.id)),
  );
  await dependencies.killWorkspaceTerminals(sourceWorkspace.workspaceId);

  const originalAgentRecords = (await dependencies.agentStorage.list()).filter(
    (record) => !record.archivedAt && record.workspaceId === sourceWorkspace.workspaceId,
  );
  const transitionedAt = new Date().toISOString();
  let workspaceMutationStarted = false;

  try {
    for (const record of originalAgentRecords) {
      await dependencies.agentStorage.upsert(
        transitionAgentRecord(record, targetWorkspace.cwd, transitionedAt),
      );
    }

    workspaceMutationStarted = true;
    const transitioned = await dependencies.workspaceRegistry.update(
      sourceWorkspace.workspaceId,
      (existing) => ({
        ...existing,
        cwd: targetWorkspace.cwd,
        kind: "worktree",
        displayName: targetWorkspace.displayName,
        branch: targetWorkspace.branch,
        worktreeRoot: targetWorkspace.worktreeRoot,
        baseBranch: targetWorkspace.baseBranch,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: targetWorkspace.mainRepoRoot,
        updatedAt: transitionedAt,
      }),
    );
    if (!transitioned) {
      throw new Error("Current workspace disappeared during transition");
    }

    await dependencies.agentManager.relocateAgentForNextResume(input.caller.id, transitioned.cwd);

    await dependencies.workspaceRegistry.remove(input.temporaryWorkspaceId).catch((error) => {
      dependencies.logger.warn(
        { err: error, workspaceId: input.temporaryWorkspaceId },
        "Failed to remove temporary workspace after transition",
      );
    });
    await dependencies.emitWorkspaceUpdate(sourceWorkspace.workspaceId).catch((error) => {
      dependencies.logger.warn(
        { err: error, workspaceId: sourceWorkspace.workspaceId },
        "Failed to emit workspace update after transition",
      );
    });

    const schedule = dependencies.schedule ?? ((callback: () => void) => setTimeout(callback, 0));
    schedule(() => {
      void dependencies.agentManager.closeAgent(input.caller.id).catch((error) => {
        dependencies.logger.warn(
          { err: error, agentId: input.caller.id },
          "Failed to close transitioned caller agent",
        );
      });
    });
    return transitioned;
  } catch (error) {
    let restored = true;
    if (workspaceMutationStarted) {
      try {
        await dependencies.workspaceRegistry.upsert(sourceWorkspace);
      } catch (restoreError) {
        restored = false;
        dependencies.logger.warn(
          { err: restoreError, workspaceId: sourceWorkspace.workspaceId },
          "Failed to restore workspace after transition failure",
        );
      }
    }
    if (!(await restoreAgentRecords(dependencies, originalAgentRecords))) {
      restored = false;
    }
    if (!restored) {
      throw new WorkspaceTransitionPreservationRequiredError(error);
    }
    throw error;
  }
}

function transitionAgentRecord(
  record: StoredAgentRecord,
  cwd: string,
  updatedAt: string,
): StoredAgentRecord {
  return { ...record, cwd, updatedAt };
}

async function restoreAgentRecords(
  dependencies: Pick<CommitWorkspaceTransitionDependencies, "agentStorage" | "logger">,
  records: StoredAgentRecord[],
): Promise<boolean> {
  let restored = true;
  for (const record of records) {
    try {
      await dependencies.agentStorage.upsert(record);
    } catch (error) {
      restored = false;
      dependencies.logger.warn(
        { err: error, agentId: record.id },
        "Failed to restore agent after transition failure",
      );
    }
  }
  return restored;
}
