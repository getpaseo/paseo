import { promises as fs } from "node:fs";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { normalizeWorkspaceId as normalizePersistedWorkspaceId } from "./workspace-registry-model.js";
import type { GitHubService } from "../services/github-service.js";
import {
  deletePaseoWorktree,
  resolvePaseoWorktreeRootForCwd,
  runWorktreeTeardownCommands,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import { runGitCommand } from "../utils/run-git-command.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

export interface ArchivePaseoWorktreeDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  github: GitHubService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: Pick<AgentManager, "listAgents" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "list">;
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
    /** Present for multi_git workspaces: the list of sub-repo worktrees to clean up. */
    subRepoWorktrees?: Array<{ name: string; repoPath: string; worktreePath: string }>;
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
  const affectedWorkspaceIds = new Set<string>([normalizePersistedWorkspaceId(targetPath)]);

  const liveAgents = dependencies.agentManager
    .listAgents()
    .filter((agent) => dependencies.isPathWithinRoot(targetPath, agent.cwd));
  for (const agent of liveAgents) {
    archivedAgents.add(agent.id);
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
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));
  const matchingStoredRecords = storedRecords.filter((record) =>
    dependencies.isPathWithinRoot(targetPath, record.cwd),
  );
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
    affectedWorkspaceCwds.add(record.cwd);
    affectedWorkspaceIds.add(normalizePersistedWorkspaceId(record.cwd));
  }

  const affectedWorkspaceIdList = Array.from(affectedWorkspaceIds);
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

    const teardownError = await teardownWorktreeFilesystem(targetPath, options, dependencies);

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

/**
 * Dispatch to either the multi_git or single-repo teardown path.
 * Returns any WorktreeTeardownError that should be re-thrown after the
 * workspace record has been archived (best-effort semantics).
 */
async function teardownWorktreeFilesystem(
  targetPath: string,
  options: {
    repoRoot: string | null;
    worktreesRoot?: string;
    worktreesBaseRoot?: string;
    subRepoWorktrees?: Array<{ name: string; repoPath: string; worktreePath: string }>;
  },
  dependencies: Pick<ArchivePaseoWorktreeDependencies, "paseoHome" | "sessionLogger">,
): Promise<WorktreeTeardownError | null> {
  const subRepoWorktrees = options.subRepoWorktrees;
  if (subRepoWorktrees && subRepoWorktrees.length > 0) {
    await teardownMultiGitWorkspace(targetPath, subRepoWorktrees, dependencies.sessionLogger);
    return null;
  }

  try {
    await deletePaseoWorktree({
      cwd: options.repoRoot,
      worktreePath: targetPath,
      worktreesRoot: options.worktreesRoot,
      paseoHome: dependencies.paseoHome,
      worktreesBaseRoot: options.worktreesBaseRoot,
    });
    return null;
  } catch (error) {
    if (error instanceof WorktreeTeardownError) {
      dependencies.sessionLogger?.warn(
        { err: error, targetPath },
        "Worktree teardown failed during archive; archiving workspace record anyway",
      );
      return error;
    }
    throw error;
  }
}

/**
 * Tear down a multi_git workspace: run paseo.json teardown commands from
 * workspaceRoot, remove each sub-repo worktree from its parent git repo,
 * then delete the workspaceRoot directory. All steps are best-effort.
 */
async function teardownMultiGitWorkspace(
  workspaceRoot: string,
  subRepoWorktrees: Array<{ name: string; repoPath: string; worktreePath: string }>,
  logger: Logger | undefined,
): Promise<void> {
  // Step 1: Run worktree.teardown commands from workspaceRoot (best-effort).
  try {
    await runWorktreeTeardownCommands({ worktreePath: workspaceRoot });
  } catch (error) {
    logger?.warn(
      { err: error, workspaceRoot },
      "Multi-git worktree teardown commands failed; continuing with cleanup",
    );
  }

  // Step 2: Remove each sub-repo worktree from its parent git repo (best-effort).
  for (const subRepo of subRepoWorktrees) {
    try {
      await runGitCommand(["worktree", "remove", "--force", subRepo.worktreePath], {
        cwd: subRepo.repoPath,
        timeout: 120_000,
      });
    } catch (error) {
      logger?.warn(
        { err: error, worktreePath: subRepo.worktreePath, repoPath: subRepo.repoPath },
        "git worktree remove failed for sub-repo during multi-git archive; continuing",
      );
    }
  }

  // Step 3: Remove the workspaceRoot directory (best-effort).
  try {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  } catch (error) {
    logger?.warn(
      { err: error, workspaceRoot },
      "Failed to remove workspaceRoot directory during multi-git archive; continuing",
    );
  }
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
