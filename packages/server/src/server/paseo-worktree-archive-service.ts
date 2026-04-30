import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { SessionOutboundMessage } from "./messages.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { normalizeWorkspaceId as normalizePersistedWorkspaceId } from "./workspace-registry-model.js";
import type { GitHubService } from "../services/github-service.js";
import { deletePaseoWorktree, resolvePaseoWorktreeRootForCwd } from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

type EmitSessionMessage = (message: SessionOutboundMessage) => void;

export interface ArchivePaseoWorktreeDependencies {
  paseoHome?: string;
  github: GitHubService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: Pick<AgentManager, "listAgents" | "closeAgent">;
  agentStorage: Pick<AgentStorage, "list" | "remove">;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emit: EmitSessionMessage;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTerminalsUnderPath: (rootPath: string) => Promise<void>;
  sessionLogger?: Logger;
}

export interface KillTerminalsUnderPathDependencies {
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTrackedTerminal: (terminalId: string, options?: { emitExit: boolean }) => void;
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
}

export async function archivePaseoWorktree(
  dependencies: ArchivePaseoWorktreeDependencies,
  options: {
    targetPath: string;
    repoRoot: string | null;
    worktreesRoot?: string;
    requestId: string;
  },
): Promise<string[]> {
  let targetPath = options.targetPath;
  const resolvedWorktree = await resolvePaseoWorktreeRootForCwd(targetPath, {
    paseoHome: dependencies.paseoHome,
  });
  if (resolvedWorktree) {
    targetPath = resolvedWorktree.worktreePath;
  }

  const removedAgents = new Set<string>();
  const affectedWorkspaceCwds = new Set<string>([targetPath]);
  const affectedWorkspaceIds = new Set<string>([normalizePersistedWorkspaceId(targetPath)]);

  const liveAgents = dependencies.agentManager
    .listAgents()
    .filter((agent) => dependencies.isPathWithinRoot(targetPath, agent.cwd));
  for (const agent of liveAgents) {
    removedAgents.add(agent.id);
    affectedWorkspaceCwds.add(agent.cwd);
    affectedWorkspaceIds.add(normalizePersistedWorkspaceId(agent.cwd));
  }

  let storedRecords: StoredAgentRecord[] = [];
  try {
    storedRecords = await dependencies.agentStorage.list();
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, targetPath },
      "Failed to list stored agents during worktree archive; continuing",
    );
  }
  const matchingStoredRecords = storedRecords.filter((record) =>
    dependencies.isPathWithinRoot(targetPath, record.cwd),
  );
  for (const record of matchingStoredRecords) {
    removedAgents.add(record.id);
    affectedWorkspaceCwds.add(record.cwd);
    affectedWorkspaceIds.add(normalizePersistedWorkspaceId(record.cwd));
  }

  const agentIdsToRemoveFromStorage = new Set<string>([
    ...liveAgents.map((agent) => agent.id),
    ...matchingStoredRecords.map((record) => record.id),
  ]);

  const affectedWorkspaceIdList = Array.from(affectedWorkspaceIds);
  dependencies.markWorkspaceArchiving(affectedWorkspaceIdList, new Date().toISOString());

  try {
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);

    const teardownResults = await Promise.allSettled([
      ...liveAgents.map((agent) => dependencies.agentManager.closeAgent(agent.id)),
      dependencies.killTerminalsUnderPath(targetPath),
    ]);

    for (const result of teardownResults) {
      if (result.status === "rejected") {
        dependencies.sessionLogger?.warn(
          { err: result.reason, targetPath },
          "Worktree teardown step failed during archive; continuing",
        );
      }
    }

    const agentIdsToRemove = Array.from(agentIdsToRemoveFromStorage);
    const storageRemovalResults = await Promise.allSettled(
      agentIdsToRemove.map((agentId) => dependencies.agentStorage.remove(agentId)),
    );
    storageRemovalResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }
      dependencies.sessionLogger?.warn(
        {
          err: result.reason,
          agentId: agentIdsToRemove[index],
          targetPath,
        },
        "Failed to remove archived worktree agent from storage; continuing",
      );
    });

    await deletePaseoWorktree({
      cwd: options.repoRoot,
      worktreePath: targetPath,
      worktreesRoot: options.worktreesRoot,
      paseoHome: dependencies.paseoHome,
    });

    if (options.repoRoot) {
      try {
        await dependencies.workspaceGitService.getSnapshot(options.repoRoot, {
          force: true,
          reason: "archive-worktree",
        });
      } catch (error) {
        dependencies.sessionLogger?.warn(
          { err: error, cwd: options.repoRoot },
          "Failed to force-refresh workspace git snapshot after archiving worktree",
        );
      }
    }

    for (const cwd of affectedWorkspaceCwds) {
      dependencies.github.invalidate({ cwd });
    }

    await Promise.all(
      affectedWorkspaceIdList.map(async (workspaceId) => {
        try {
          await dependencies.archiveWorkspaceRecord(workspaceId);
        } catch (error) {
          dependencies.sessionLogger?.warn(
            { err: error, workspaceId },
            "Failed to archive workspace record; worktree FS already removed",
          );
        }
      }),
    );

    for (const agentId of removedAgents) {
      dependencies.emit({
        type: "agent_deleted",
        payload: {
          agentId,
          requestId: options.requestId,
        },
      });
    }
  } finally {
    dependencies.clearWorkspaceArchiving(affectedWorkspaceIdList);
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);
  }

  return Array.from(removedAgents);
}

export async function killTerminalsUnderPath(
  dependencies: KillTerminalsUnderPathDependencies,
  rootPath: string,
): Promise<void> {
  const terminalManager = dependencies.terminalManager;
  if (!terminalManager) {
    return;
  }

  const terminalIds: string[] = [];
  const relevantCwds = [...terminalManager.listDirectories()].filter((terminalCwd) =>
    dependencies.isPathWithinRoot(rootPath, terminalCwd),
  );
  const terminalLists = await Promise.all(
    relevantCwds.map(async (terminalCwd) => {
      try {
        return await terminalManager.getTerminals(terminalCwd);
      } catch (error) {
        dependencies.sessionLogger.warn(
          { err: error, cwd: terminalCwd },
          "Failed to enumerate worktree terminals during archive",
        );
        return [];
      }
    }),
  );
  for (const terminals of terminalLists) {
    for (const terminal of terminals) {
      terminalIds.push(terminal.id);
    }
  }

  if (terminalIds.length === 0) {
    return;
  }

  await Promise.allSettled(
    terminalIds.map(async (terminalId) => {
      try {
        dependencies.detachTerminalStream?.(terminalId, { emitExit: true });
        await terminalManager.killTerminalAndWait(terminalId, {
          gracefulTimeoutMs: 2000,
          forceTimeoutMs: 1500,
        });
      } catch (error) {
        dependencies.sessionLogger.warn(
          { err: error, terminalId },
          "Terminal kill escalation failed during archive; proceeding anyway",
        );
      }
    }),
  );
}
