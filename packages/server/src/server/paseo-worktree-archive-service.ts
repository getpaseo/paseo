import { resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { GitHubService } from "../services/github-service.js";
import {
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  resolvePaseoWorktreeRootForCwd,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

export interface ActiveWorkspaceRef {
  workspaceId: string;
  cwd: string;
  kind?: "local_checkout" | "worktree" | "directory";
}

export interface ArchivePaseoWorktreeDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  github: GitHubService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: Pick<AgentManager, "listAgents" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "list">;
  resolveWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  // Active (non-archived) workspaces, used to decide whether the workspace being
  // archived is the last reference to its backing worktree directory, and to
  // break a same-cwd tie in favor of the worktree-kind record when archiving by
  // path (no explicit workspaceId).
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  sessionLogger?: Logger;
}

export interface KillTerminalsForWorkspaceDependencies {
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
}

// Archiving is scoped to a single workspace RECORD (by workspaceId), not to a
// directory. A directory can back multiple workspaces (Model B), so cwd-scoped
// teardown would destroy a sibling workspace's agents and terminals. We tear
// down only the agents and terminals owned by the target workspaceId.
//
// On-disk worktree removal is opt-in (deleteWorktreeFromDisk) and only happens
// when this workspace is the LAST active reference to a Paseo-owned worktree
// directory. If a sibling workspace still references the directory, it is kept.
// Local checkouts are never deleted.
export async function archivePaseoWorktree(
  dependencies: ArchivePaseoWorktreeDependencies,
  options: {
    targetPath: string;
    repoRoot: string | null;
    worktreesRoot?: string;
    worktreesBaseRoot?: string;
    workspaceId?: string;
    deleteWorktreeFromDisk?: boolean;
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

  // A directory can back multiple workspaces (Model B), so resolving the target
  // by cwd alone picks an arbitrary record. Prefer the explicit workspaceId the
  // caller supplied; otherwise resolve by path, breaking a same-cwd tie toward
  // the worktree-kind record.
  const targetWorkspaceId =
    options.workspaceId ?? (await resolveTargetWorkspaceId(dependencies, targetPath));
  if (!targetWorkspaceId) {
    dependencies.sessionLogger?.warn(
      { targetPath },
      "Skipping workspace archive for unregistered directory",
    );
    return [];
  }

  const affectedWorkspaceIdList = [targetWorkspaceId];
  dependencies.markWorkspaceArchiving(affectedWorkspaceIdList, new Date().toISOString());

  let archivedAgents = new Set<string>();

  try {
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);

    archivedAgents = await archiveWorkspaceContents(dependencies, targetWorkspaceId);

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

    dependencies.github.invalidate({ cwd: targetPath });

    try {
      await dependencies.archiveWorkspaceRecord(targetWorkspaceId);
    } catch (error) {
      dependencies.sessionLogger?.warn(
        { err: error, workspaceId: targetWorkspaceId },
        "Failed to archive workspace record",
      );
    }

    if (options.deleteWorktreeFromDisk) {
      await deleteWorktreeFromDiskIfLastReference(dependencies, {
        targetPath,
        targetWorkspaceId,
        repoRoot: options.repoRoot,
        worktreesRoot: options.worktreesRoot,
        worktreesBaseRoot: options.worktreesBaseRoot,
      });
    }
  } finally {
    dependencies.clearWorkspaceArchiving(affectedWorkspaceIdList);
    await dependencies.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIdList);
  }

  return Array.from(archivedAgents);
}

// Resolves the workspace record to archive when no explicit workspaceId was
// supplied. When several active workspaces share the exact target cwd, prefer
// the worktree-kind record so archiving-by-path tears down the worktree rather
// than an arbitrary sibling. Falls back to the path-based resolver otherwise.
async function resolveTargetWorkspaceId(
  dependencies: Pick<
    ArchivePaseoWorktreeDependencies,
    "resolveWorkspaceIdForCwd" | "listActiveWorkspaces"
  >,
  targetPath: string,
): Promise<string | null> {
  const targetDir = resolve(targetPath);
  const exactMatches = (await dependencies.listActiveWorkspaces()).filter(
    (workspace) => resolve(workspace.cwd) === targetDir,
  );
  const worktreeMatch = exactMatches.find((workspace) => workspace.kind === "worktree");
  if (worktreeMatch) {
    return worktreeMatch.workspaceId;
  }
  return dependencies.resolveWorkspaceIdForCwd(targetPath);
}

export type ArchiveWorkspaceContentsDependencies = Pick<
  ArchivePaseoWorktreeDependencies,
  "agentManager" | "agentStorage" | "killTerminalsForWorkspace" | "sessionLogger"
>;

// Tears down everything OWNED by a single workspace record: its live agents,
// its persisted-but-not-running agent snapshots, and its terminals. Scoped by
// workspaceId so a sibling workspace sharing the same directory is untouched.
// Returns the set of archived agent ids.
export async function archiveWorkspaceContents(
  dependencies: ArchiveWorkspaceContentsDependencies,
  workspaceId: string,
): Promise<Set<string>> {
  const archivedAgents = new Set<string>();

  const liveAgents = dependencies.agentManager
    .listAgents()
    .filter((agent) => agent.workspaceId === workspaceId);
  for (const agent of liveAgents) {
    archivedAgents.add(agent.id);
  }

  let storedRecords: StoredAgentRecord[] = [];
  try {
    storedRecords = await dependencies.agentStorage.list();
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, workspaceId },
      "Failed to list stored agents during workspace archive; continuing",
    );
  }
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));
  const matchingStoredRecords = storedRecords.filter(
    (record) => record.workspaceId === workspaceId,
  );
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
  }

  const archivedAt = new Date().toISOString();
  const archiveResults = await Promise.allSettled([
    ...liveAgents.map((agent) => dependencies.agentManager.archiveAgent(agent.id)),
    ...matchingStoredRecords
      .filter((record) => !liveAgentIds.has(record.id) && !record.archivedAt)
      .map((record) => dependencies.agentManager.archiveSnapshot(record.id, archivedAt)),
    dependencies.killTerminalsForWorkspace(workspaceId),
  ]);

  for (const result of archiveResults) {
    if (result.status === "rejected") {
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId },
        "Workspace archive teardown step failed; continuing",
      );
    }
  }

  return archivedAgents;
}

// Removes the worktree directory from disk, but only when the just-archived
// workspace was the last active reference to a Paseo-owned worktree. A directory
// can back multiple workspaces (Model B), so a sibling still referencing it must
// keep the directory. Local checkouts are never Paseo-owned and so never deleted.
async function deleteWorktreeFromDiskIfLastReference(
  dependencies: Pick<
    ArchivePaseoWorktreeDependencies,
    "paseoHome" | "worktreesRoot" | "listActiveWorkspaces" | "github" | "sessionLogger"
  >,
  options: {
    targetPath: string;
    targetWorkspaceId: string;
    repoRoot: string | null;
    worktreesRoot?: string;
    worktreesBaseRoot?: string;
  },
): Promise<void> {
  const ownership = await isPaseoOwnedWorktreeCwd(options.targetPath, {
    paseoHome: dependencies.paseoHome,
    worktreesRoot: options.worktreesBaseRoot ?? dependencies.worktreesRoot,
  });
  if (!ownership.allowed) {
    return;
  }

  const targetDir = resolve(options.targetPath);
  const activeWorkspaces = await dependencies.listActiveWorkspaces();
  const siblingStillReferences = activeWorkspaces.some(
    (workspace) =>
      workspace.workspaceId !== options.targetWorkspaceId && resolve(workspace.cwd) === targetDir,
  );
  if (siblingStillReferences) {
    return;
  }

  try {
    await deletePaseoWorktree({
      cwd: options.repoRoot,
      worktreePath: options.targetPath,
      worktreesRoot: options.worktreesRoot,
      paseoHome: dependencies.paseoHome,
      worktreesBaseRoot: options.worktreesBaseRoot ?? dependencies.worktreesRoot,
    });
    dependencies.github.invalidate({ cwd: options.targetPath });
  } catch (error) {
    if (error instanceof WorktreeTeardownError) {
      dependencies.sessionLogger?.warn(
        { err: error, targetPath: options.targetPath },
        "Worktree disk removal failed during archive; workspace already archived",
      );
      return;
    }
    throw error;
  }
}

export async function killTerminalsForWorkspace(
  dependencies: KillTerminalsForWorkspaceDependencies,
  workspaceId: string,
): Promise<void> {
  const terminalManager = dependencies.terminalManager;
  if (!terminalManager) {
    return;
  }

  const terminalIds: string[] = [];
  const terminalLists = await Promise.all(
    terminalManager.listDirectories().map(async (terminalCwd) => {
      try {
        return await terminalManager.getTerminals(terminalCwd, { workspaceId });
      } catch (error) {
        dependencies.sessionLogger.warn(
          { err: error, cwd: terminalCwd },
          "Failed to enumerate workspace terminals during archive",
        );
        return [];
      }
    }),
  );
  for (const terminals of terminalLists) {
    for (const terminal of terminals) {
      if (terminal.workspaceId === workspaceId) {
        terminalIds.push(terminal.id);
      }
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
