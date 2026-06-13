import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { GitHubService } from "../services/github-service.js";
import {
  deletePaseoWorktree,
  resolvePaseoWorktreeRootForCwd,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

export interface ArchivePaseoWorktreeDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  github: GitHubService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: Pick<AgentManager, "listAgents" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "list">;
  resolveWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
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
    worktreesBaseRoot?: string;
    requestId: string;
  },
): Promise<string[]> {
  let targetPath = options.targetPath;
  const resolvedWorktree = await resolvePaseoWorktreeRootForCwd(targetPath, {
    paseoHome: dependencies.paseoHome,
    worktreesRoot: options.worktreesBaseRoot ?? dependencies.worktreesRoot,
  });
  if (resolvedWorktree) {
    targetPath = resolvedWorktree.worktreePath;
  }

  const archivedAgents = new Set<string>();
  const affectedWorkspaceCwds = new Set<string>([targetPath]);

  const liveAgents = dependencies.agentManager
    .listAgents()
    .filter((agent) => dependencies.isPathWithinRoot(targetPath, agent.cwd));
  for (const agent of liveAgents) {
    archivedAgents.add(agent.id);
    affectedWorkspaceCwds.add(agent.cwd);
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
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));
  const matchingStoredRecords = storedRecords.filter((record) =>
    dependencies.isPathWithinRoot(targetPath, record.cwd),
  );
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
    affectedWorkspaceCwds.add(record.cwd);
  }

  const affectedWorkspaceIdList = await resolveAffectedWorkspaceIds(
    dependencies,
    affectedWorkspaceCwds,
  );
  dependencies.markWorkspaceArchiving(affectedWorkspaceIdList, new Date().toISOString());

  try {
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);

    const archivedAt = new Date().toISOString();
    const archiveResults = await Promise.allSettled([
      ...liveAgents.map((agent) => dependencies.agentManager.archiveAgent(agent.id)),
      ...matchingStoredRecords
        .filter((record) => !liveAgentIds.has(record.id) && !record.archivedAt)
        .map((record) => dependencies.agentManager.archiveSnapshot(record.id, archivedAt)),
      dependencies.killTerminalsUnderPath(targetPath),
    ]);

    for (const result of archiveResults) {
      if (result.status === "rejected") {
        dependencies.sessionLogger?.warn(
          { err: result.reason, targetPath },
          "Worktree archive teardown step failed; continuing",
        );
      }
    }

    let teardownError: WorktreeTeardownError | null = null;
    try {
      await deletePaseoWorktree({
        cwd: options.repoRoot,
        worktreePath: targetPath,
        worktreesRoot: options.worktreesRoot,
        paseoHome: dependencies.paseoHome,
        worktreesBaseRoot: options.worktreesBaseRoot ?? dependencies.worktreesRoot,
      });
    } catch (error) {
      if (error instanceof WorktreeTeardownError) {
        teardownError = error;
        dependencies.sessionLogger?.warn(
          { err: error, targetPath },
          "Worktree teardown failed during archive; archiving workspace record anyway",
        );
      } else {
        throw error;
      }
    }

    if (!teardownError && options.repoRoot) {
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
            teardownError
              ? "Failed to archive workspace record after teardown failed"
              : "Failed to archive workspace record; worktree FS already removed",
          );
        }
      }),
    );

    if (teardownError) {
      throw teardownError;
    }
  } finally {
    dependencies.clearWorkspaceArchiving(affectedWorkspaceIdList);
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);
  }

  return Array.from(archivedAgents);
}

async function resolveAffectedWorkspaceIds(
  dependencies: Pick<
    ArchivePaseoWorktreeDependencies,
    "resolveWorkspaceIdForCwd" | "sessionLogger"
  >,
  cwds: Iterable<string>,
): Promise<string[]> {
  const workspaceIds = new Set<string>();
  for (const cwd of cwds) {
    const workspaceId = await dependencies.resolveWorkspaceIdForCwd(cwd);
    if (!workspaceId) {
      dependencies.sessionLogger?.warn(
        { cwd },
        "Skipping workspace archive update for unregistered directory",
      );
      continue;
    }
    workspaceIds.add(workspaceId);
  }
  return Array.from(workspaceIds);
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
