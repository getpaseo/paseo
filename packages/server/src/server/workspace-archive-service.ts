import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  runWorktreeTeardownCommands,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type {
  PersistedWorkspaceCleanupPending,
  PersistedWorkspaceRecord,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import {
  defaultWorkspaceLifecycleCoordinator,
  type WorkspaceLifecycleCoordinator,
} from "./workspace-lifecycle-coordinator.js";

export type ActiveWorkspaceRef = Pick<
  PersistedWorkspaceRecord,
  "workspaceId" | "cwd" | "kind" | "worktreeRoot" | "isPaseoOwnedWorktree" | "mainRepoRoot"
>;

export interface ArchiveDependencies {
  paseoHome?: string;
  // Base directory that may hold worktrees across repositories.
  paseoWorktreesBaseRoot?: string;
  github: ForgeService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot">;
  agentManager: Pick<AgentManager, "listAgents" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "list">;
  // Resolves the worktree at a path to its workspaceId for archive-by-path. The
  // path uniquely identifies a worktree workspace; this is a directory lookup for
  // the archive target, not status/ownership.
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
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
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "update">;
  lifecycleCoordinator?: WorkspaceLifecycleCoordinator;
  sessionLogger?: Logger;
}

export interface KillTerminalsForWorkspaceDependencies {
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
}

export type ArchiveScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "worktree"; targetPath: string };

export interface ArchiveResult {
  archivedAgentIds: string[];
  archivedWorkspaceIds: string[];
  removedDirectory: boolean;
}

export interface ArchiveByScopeRequest {
  scope: ArchiveScope;
  requestId: string;
}

export async function requireActiveWorkspaceForArchive(
  dependencies: Pick<ArchiveDependencies, "listActiveWorkspaces">,
  workspaceId: string,
): Promise<ActiveWorkspaceRef> {
  const workspace = (await dependencies.listActiveWorkspaces()).find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

interface BackingDirectory {
  path: string;
  isPaseoOwnedWorktree: boolean;
  mainRepoRoot: string | null;
  paseoWorktreesRoot: string | null;
}

interface ArchiveTarget {
  backing: BackingDirectory | null;
  teardownTargets: Array<{ workspaceId: string | null; cwd: string }>;
  workspaceIds: string[];
}

export async function resolveWorkspaceIdAtPath(
  dependencies: Pick<ArchiveDependencies, "findWorkspaceIdForCwd" | "listActiveWorkspaces">,
  targetPath: string,
): Promise<string | null> {
  const matchesTarget = createRealpathAwarePathMatcher(targetPath);
  const activeWorkspaces = await dependencies.listActiveWorkspaces();
  const exactMatches = activeWorkspaces.filter((workspace) => matchesTarget(workspace.cwd));
  const worktreeMatch = exactMatches.find((workspace) => workspace.kind === "worktree");
  if (worktreeMatch) {
    return worktreeMatch.workspaceId;
  }
  return dependencies.findWorkspaceIdForCwd(targetPath);
}

// Resolves the in-scope record set, tears each down
// (agents + terminals + record), then removes the backing directory iff it is
// Paseo-owned AND no active workspace still references it.
export async function archiveByScope(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
): Promise<ArchiveResult> {
  const initialTarget = await resolveArchiveTarget(dependencies, request.scope);
  const lifecycleCoordinator =
    dependencies.lifecycleCoordinator ?? defaultWorkspaceLifecycleCoordinator;
  const operationKey =
    request.scope.kind === "workspace"
      ? `workspace:${request.scope.workspaceId}`
      : `worktree:${resolve(request.scope.targetPath)}`;

  return lifecycleCoordinator.runArchive(operationKey, async () => {
    await lifecycleCoordinator.waitForWorkspaceSetups(initialTarget.workspaceIds);
    const refreshedTarget = await resolveArchiveTarget(dependencies, request.scope);
    const target = mergeArchiveTargets(initialTarget, refreshedTarget);
    return archiveResolvedTarget(dependencies, lifecycleCoordinator, request, target);
  });
}

function mergeArchiveTargets(initial: ArchiveTarget, refreshed: ArchiveTarget): ArchiveTarget {
  if (refreshed.backing !== null || refreshed.workspaceIds.length > 0) {
    return refreshed;
  }
  return {
    backing: initial.backing,
    teardownTargets: initial.teardownTargets,
    workspaceIds: [],
  };
}

async function archiveResolvedTarget(
  dependencies: ArchiveDependencies,
  lifecycleCoordinator: WorkspaceLifecycleCoordinator,
  request: ArchiveByScopeRequest,
  target: ArchiveTarget,
): Promise<ArchiveResult> {
  const targetWorkspaceIds = target.workspaceIds;

  if (targetWorkspaceIds.length > 0) {
    dependencies.markWorkspaceArchiving(targetWorkspaceIds, new Date().toISOString());
  }

  let removedDirectory = false;

  try {
    if (targetWorkspaceIds.length > 0) {
      await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
    }

    await persistTargetCleanupPending(dependencies, target);

    const { archivedAgents, archivedWorkspaceIds } = await archiveTargetRecords(
      dependencies,
      targetWorkspaceIds,
      request.requestId,
    );
    await clearCleanupPendingForUnarchivedTargets(dependencies, target, archivedWorkspaceIds);

    if (target.backing?.mainRepoRoot) {
      try {
        await dependencies.workspaceGitService.getSnapshot(target.backing.mainRepoRoot, {
          force: true,
          reason: "archive-worktree",
        });
      } catch (error) {
        dependencies.sessionLogger?.warn(
          { err: error, cwd: target.backing.mainRepoRoot, requestId: request.requestId },
          "Failed to force-refresh workspace git snapshot after archiving",
        );
      }
    }

    if (target.backing !== null) {
      removedDirectory = await maybeRemoveDirectory(
        dependencies,
        lifecycleCoordinator,
        request,
        target,
        archivedWorkspaceIds,
      );
    }

    return {
      archivedAgentIds: Array.from(archivedAgents),
      archivedWorkspaceIds,
      removedDirectory,
    };
  } finally {
    if (targetWorkspaceIds.length > 0) {
      dependencies.clearWorkspaceArchiving(targetWorkspaceIds);
      await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
    }
  }
}

async function resolveArchiveTarget(
  dependencies: ArchiveDependencies,
  scope: ArchiveScope,
): Promise<ArchiveTarget> {
  const activeWorkspaces = await dependencies.listActiveWorkspaces();

  if (scope.kind === "workspace") {
    const workspaceId = scope.workspaceId;
    const record = activeWorkspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) {
      const persistedRecord = await dependencies.workspaceRegistry?.get(workspaceId);
      if (persistedRecord?.cleanupPending) {
        return archiveTargetFromPendingCleanup(workspaceId, persistedRecord.cleanupPending);
      }
      dependencies.sessionLogger?.warn(
        { workspaceId },
        "Workspace not found for archive-by-scope; skipping",
      );
      return { backing: null, teardownTargets: [], workspaceIds: [] };
    }
    return {
      backing: await resolveWorkspaceBackingDirectory(record, dependencies),
      teardownTargets: [{ workspaceId, cwd: record.cwd }],
      workspaceIds: [workspaceId],
    };
  }

  return resolveWorktreeArchiveTarget(dependencies, scope.targetPath, activeWorkspaces);
}

async function resolveWorktreeArchiveTarget(
  dependencies: ArchiveDependencies,
  targetPath: string,
  activeWorkspaces: ActiveWorkspaceRef[],
): Promise<ArchiveTarget> {
  const backing = await resolveBackingDirectory(targetPath, dependencies);
  const matchesBackingDirectory = createRealpathAwarePathMatcher(backing.path);
  const targetWorkspaces = (
    await Promise.all(
      activeWorkspaces.map(async (workspace) => {
        const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
        return matchesBackingDirectory(backingDirectory.path) ? workspace : null;
      }),
    )
  ).filter((workspace): workspace is ActiveWorkspaceRef => workspace !== null);
  const pendingRecords = (await dependencies.workspaceRegistry?.list())?.filter(
    (workspace) =>
      workspace.cleanupPending !== null &&
      matchesBackingDirectory(workspace.cleanupPending.directoryPath),
  );
  const pendingCleanup = pendingRecords?.[0]?.cleanupPending ?? null;
  const persistedMainRepoRoot = targetWorkspaces.find(
    (workspace) => workspace.mainRepoRoot,
  )?.mainRepoRoot;
  let teardownTargets: ArchiveTarget["teardownTargets"];
  if (targetWorkspaces.length > 0) {
    teardownTargets = targetWorkspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
    }));
  } else if (pendingRecords && pendingRecords.length > 0) {
    teardownTargets = pendingRecords.flatMap((workspace) => {
      if (!workspace.cleanupPending) return [];
      return [
        {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cleanupPending.teardownCwd,
        },
      ];
    });
  } else {
    teardownTargets = [{ workspaceId: null, cwd: targetPath }];
  }

  return {
    backing: {
      path: pendingCleanup?.directoryPath ?? backing.path,
      isPaseoOwnedWorktree: pendingCleanup !== null || backing.isPaseoOwnedWorktree,
      mainRepoRoot: persistedMainRepoRoot ?? pendingCleanup?.mainRepoRoot ?? backing.mainRepoRoot,
      paseoWorktreesRoot: pendingCleanup?.paseoWorktreesRoot ?? backing.paseoWorktreesRoot,
    },
    teardownTargets,
    workspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
  };
}

function archiveTargetFromPendingCleanup(
  workspaceId: string,
  cleanupPending: PersistedWorkspaceCleanupPending,
): ArchiveTarget {
  return {
    backing: {
      path: cleanupPending.directoryPath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: cleanupPending.mainRepoRoot,
      paseoWorktreesRoot: cleanupPending.paseoWorktreesRoot,
    },
    teardownTargets: [{ workspaceId, cwd: cleanupPending.teardownCwd }],
    workspaceIds: [],
  };
}

async function resolveWorkspaceBackingDirectory(
  workspace: ActiveWorkspaceRef,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<BackingDirectory> {
  if (workspace.isPaseoOwnedWorktree && workspace.worktreeRoot && workspace.mainRepoRoot) {
    return {
      path: resolve(workspace.worktreeRoot),
      isPaseoOwnedWorktree: true,
      mainRepoRoot: workspace.mainRepoRoot,
      paseoWorktreesRoot: null,
    };
  }
  if (workspace.kind !== "worktree") {
    return {
      path: resolve(workspace.cwd),
      isPaseoOwnedWorktree: false,
      mainRepoRoot: workspace.mainRepoRoot ?? null,
      paseoWorktreesRoot: null,
    };
  }

  // COMPAT(archiveMissingWorkspacePlacement): worktree records created before v0.1.110
  // lack durable backing ownership; remove filesystem discovery after 2027-01-17.
  const backing = await resolveBackingDirectory(
    workspace.worktreeRoot ?? workspace.cwd,
    dependencies,
  );
  return { ...backing, mainRepoRoot: workspace.mainRepoRoot ?? backing.mainRepoRoot };
}

async function resolveBackingDirectory(
  cwd: string,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<BackingDirectory> {
  const options = {
    paseoHome: dependencies.paseoHome,
    worktreesRoot: dependencies.paseoWorktreesBaseRoot,
  };
  const ownership = await isPaseoOwnedWorktreeCwd(cwd, options);
  return {
    path: resolve(ownership.allowed && ownership.worktreePath ? ownership.worktreePath : cwd),
    isPaseoOwnedWorktree: ownership.allowed,
    mainRepoRoot: ownership.repoRoot ?? null,
    paseoWorktreesRoot: ownership.worktreeRoot ?? null,
  };
}

async function archiveTargetRecords(
  dependencies: ArchiveDependencies,
  targetWorkspaceIds: string[],
  requestId: string,
): Promise<{ archivedAgents: Set<string>; archivedWorkspaceIds: string[] }> {
  const archivedAgents = new Set<string>();
  const archivedWorkspaceIds: string[] = [];

  const results = await Promise.allSettled(
    targetWorkspaceIds.map(async (workspaceId) => {
      const agents = await archiveWorkspaceContents(dependencies, workspaceId);
      await dependencies.archiveWorkspaceRecord(workspaceId);
      return { workspaceId, agents };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      archivedWorkspaceIds.push(result.value.workspaceId);
      for (const agentId of result.value.agents) {
        archivedAgents.add(agentId);
      }
    } else {
      dependencies.sessionLogger?.warn(
        { err: result.reason, requestId },
        "archiveByScope workspace teardown failed; continuing",
      );
    }
  }

  return { archivedAgents, archivedWorkspaceIds };
}

async function maybeRemoveDirectory(
  dependencies: ArchiveDependencies,
  lifecycleCoordinator: WorkspaceLifecycleCoordinator,
  request: Pick<ArchiveByScopeRequest, "requestId">,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<boolean> {
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree) {
    return false;
  }

  return lifecycleCoordinator.runDirectoryExclusive(backing.path, async () => {
    return maybeRemoveDirectoryExclusive(dependencies, request, target, archivedWorkspaceIds);
  });
}

async function maybeRemoveDirectoryExclusive(
  dependencies: ArchiveDependencies,
  request: Pick<ArchiveByScopeRequest, "requestId">,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<boolean> {
  const backing = target.backing;
  if (!backing) return false;

  const pendingCleanupTargets = await listPendingCleanupTargets(
    dependencies,
    target,
    archivedWorkspaceIds,
  );
  if (pendingCleanupTargets.length === 0) {
    return false;
  }

  if (!existsSync(backing.path)) {
    await clearPendingCleanup(dependencies, pendingCleanupTargets);
    return false;
  }

  const teardownCwds = uniqueFilesystemPaths(
    pendingCleanupTargets.map((pendingCleanupTarget) => pendingCleanupTarget.teardownCwd),
  );

  try {
    for (const teardownCwd of teardownCwds) {
      await runWorktreeTeardownCommands({
        worktreePath: backing.path,
        teardownCwd,
        repoRootPath: backing.mainRepoRoot ?? undefined,
      });
    }
  } catch (error) {
    if (error instanceof WorktreeTeardownError) {
      dependencies.sessionLogger?.warn(
        { err: error, targetPath: backing.path, requestId: request.requestId },
        "Worktree teardown failed during archive; workspace already archived",
      );
      return false;
    }
    throw error;
  }

  const remainingActive = await dependencies.listActiveWorkspaces();
  if (
    !(await isDirectoryUnreferenced(
      remainingActive,
      backing.path,
      new Set(archivedWorkspaceIds),
      dependencies,
    ))
  ) {
    await clearPendingCleanup(dependencies, pendingCleanupTargets);
    return false;
  }

  try {
    await deletePaseoWorktree({
      cwd: backing.mainRepoRoot,
      worktreePath: backing.path,
      teardownCwds: [],
      worktreesRoot: backing.paseoWorktreesRoot ?? undefined,
      paseoHome: dependencies.paseoHome,
      worktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
    });
    dependencies.github.invalidate({ cwd: backing.path });
    await clearPendingCleanup(dependencies, pendingCleanupTargets);
    return true;
  } catch (error) {
    if (error instanceof WorktreeTeardownError) {
      dependencies.sessionLogger?.warn(
        { err: error, targetPath: backing.path, requestId: request.requestId },
        "Worktree disk removal failed during archive; workspace already archived",
      );
      return false;
    }
    throw error;
  }
}

interface PendingCleanupTarget extends PersistedWorkspaceCleanupPending {
  workspaceId: string | null;
}

async function persistTargetCleanupPending(
  dependencies: ArchiveDependencies,
  target: ArchiveTarget,
): Promise<void> {
  const backing = target.backing;
  const workspaceRegistry = dependencies.workspaceRegistry;
  if (!backing?.isPaseoOwnedWorktree || !workspaceRegistry) return;

  await Promise.all(
    target.teardownTargets.flatMap((teardownTarget) =>
      teardownTarget.workspaceId
        ? [
            workspaceRegistry.update(teardownTarget.workspaceId, (workspace) => ({
              ...workspace,
              cleanupPending: {
                directoryPath: backing.path,
                teardownCwd: teardownTarget.cwd,
                mainRepoRoot: backing.mainRepoRoot,
                paseoWorktreesRoot: backing.paseoWorktreesRoot,
              },
            })),
          ]
        : [],
    ),
  );
}

async function listPendingCleanupTargets(
  dependencies: ArchiveDependencies,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<PendingCleanupTarget[]> {
  const backingPath = target.backing?.path;
  const workspaceRegistry = dependencies.workspaceRegistry;
  if (backingPath && workspaceRegistry) {
    const matchesBacking = createRealpathAwarePathMatcher(backingPath);
    const records = await workspaceRegistry.list();
    return records.flatMap((workspace) => {
      const cleanupPending = workspace.cleanupPending;
      if (
        !workspace.archivedAt ||
        !cleanupPending ||
        !matchesBacking(cleanupPending.directoryPath)
      ) {
        return [];
      }
      return [{ workspaceId: workspace.workspaceId, ...cleanupPending }];
    });
  }

  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  return target.teardownTargets
    .filter(
      (teardownTarget) =>
        teardownTarget.workspaceId === null ||
        archivedWorkspaceIdSet.has(teardownTarget.workspaceId),
    )
    .map((teardownTarget) => ({
      workspaceId: teardownTarget.workspaceId,
      directoryPath: target.backing?.path ?? teardownTarget.cwd,
      teardownCwd: teardownTarget.cwd,
      mainRepoRoot: target.backing?.mainRepoRoot ?? null,
      paseoWorktreesRoot: target.backing?.paseoWorktreesRoot ?? null,
    }));
}

async function clearPendingCleanup(
  dependencies: ArchiveDependencies,
  cleanupTargets: PendingCleanupTarget[],
): Promise<void> {
  const workspaceRegistry = dependencies.workspaceRegistry;
  if (!workspaceRegistry) return;
  await Promise.all(
    cleanupTargets.flatMap((cleanupTarget) =>
      cleanupTarget.workspaceId
        ? [
            workspaceRegistry.update(cleanupTarget.workspaceId, (workspace) => ({
              ...workspace,
              cleanupPending: null,
            })),
          ]
        : [],
    ),
  );
}

async function clearCleanupPendingForUnarchivedTargets(
  dependencies: ArchiveDependencies,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<void> {
  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  const targetWorkspaceIdSet = new Set(target.workspaceIds);
  await clearPendingCleanup(
    dependencies,
    target.teardownTargets.flatMap((teardownTarget) =>
      teardownTarget.workspaceId &&
      targetWorkspaceIdSet.has(teardownTarget.workspaceId) &&
      !archivedWorkspaceIdSet.has(teardownTarget.workspaceId)
        ? [
            {
              workspaceId: teardownTarget.workspaceId,
              directoryPath: target.backing?.path ?? teardownTarget.cwd,
              teardownCwd: teardownTarget.cwd,
              mainRepoRoot: target.backing?.mainRepoRoot ?? null,
              paseoWorktreesRoot: target.backing?.paseoWorktreesRoot ?? null,
            },
          ]
        : [],
    ),
  );
}

function uniqueFilesystemPaths(paths: string[]): string[] {
  const unique: string[] = [];
  for (const candidate of paths) {
    if (!unique.some((existing) => createRealpathAwarePathMatcher(existing)(candidate))) {
      unique.push(candidate);
    }
  }
  return unique;
}

export type ArchiveWorkspaceContentsDependencies = Pick<
  ArchiveDependencies,
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

// True when, after archiving
// the in-scope records, no active workspace still points at targetDir. Derived
// from records each call — no stored counter.
async function isDirectoryUnreferenced(
  activeWorkspaces: ActiveWorkspaceRef[],
  targetDir: string,
  archivedWorkspaceIds: ReadonlySet<string>,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<boolean> {
  const target = resolve(targetDir);
  const matchesTarget = createRealpathAwarePathMatcher(target);
  for (const workspace of activeWorkspaces) {
    if (archivedWorkspaceIds.has(workspace.workspaceId)) continue;
    const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
    if (matchesTarget(backingDirectory.path)) return false;
  }
  return true;
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

// Archiving the last workspace of a project leaves the project record active.
// The user removes the project explicitly, so we never archive the parent here.
export async function archivePersistedWorkspaceRecord(input: {
  workspaceId: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "archive">;
  archivedAt?: string;
}): Promise<PersistedWorkspaceRecord | null> {
  const existingWorkspace = await input.workspaceRegistry.get(input.workspaceId);
  if (!existingWorkspace) {
    return null;
  }

  if (existingWorkspace.archivedAt) {
    return existingWorkspace;
  }

  const archivedAt = input.archivedAt ?? new Date().toISOString();
  await input.workspaceRegistry.archive(input.workspaceId, archivedAt);

  return existingWorkspace;
}
