import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  deletePaseoWorktree,
  getPaseoWorktreesRoot,
  isPaseoOwnedWorktreeCwd,
  runWorktreeTeardownCommands,
  WorktreeTeardownError,
} from "../utils/worktree.js";
import {
  ensurePaseoWorktreeIncarnationId,
  readPaseoWorktreeIncarnationId,
} from "../utils/worktree-metadata.js";
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
  cleanupPendingWorkspaceIds: string[];
}

export class WorkspaceArchiveTargetNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = "WorkspaceArchiveTargetNotFoundError";
  }
}

export class WorkspaceCleanupPendingError extends Error {
  readonly workspaceIds: readonly string[];

  constructor(operation: string, workspaceIds: readonly string[]) {
    super(`${operation} left cleanup pending for: ${workspaceIds.join(", ")}`);
    this.name = "WorkspaceCleanupPendingError";
    this.workspaceIds = [...workspaceIds];
  }
}

export function requireArchiveCleanupComplete(
  result: ArchiveResult,
  operation: string,
): ArchiveResult {
  if (result.cleanupPendingWorkspaceIds.length > 0) {
    throw new WorkspaceCleanupPendingError(operation, result.cleanupPendingWorkspaceIds);
  }
  return result;
}

export interface ArchiveByScopeRequest {
  scope: ArchiveScope;
  requestId: string;
}

export async function requireActiveWorkspaceForArchive(
  dependencies: Pick<ArchiveDependencies, "listActiveWorkspaces" | "workspaceRegistry">,
  workspaceId: string,
): Promise<ActiveWorkspaceRef> {
  const workspace = (await dependencies.listActiveWorkspaces()).find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (workspace) {
    return workspace;
  }
  const persistedWorkspace = await dependencies.workspaceRegistry?.get(workspaceId);
  if (persistedWorkspace?.cleanupPending) {
    return persistedWorkspace;
  }
  throw new WorkspaceArchiveTargetNotFoundError(workspaceId);
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
  const lifecycleCoordinator =
    dependencies.lifecycleCoordinator ?? defaultWorkspaceLifecycleCoordinator;
  const operationKey =
    request.scope.kind === "workspace"
      ? `workspace:${request.scope.workspaceId}`
      : `worktree:${resolve(request.scope.targetPath)}`;

  return lifecycleCoordinator.runArchive(operationKey, async () => {
    const initialTarget = await resolveArchiveTarget(dependencies, request.scope);
    const archiveReservation = lifecycleCoordinator.reserveWorkspaceArchive(
      initialTarget.workspaceIds,
    );
    const archiveOperation = async () => {
      const closureWorkspaceIds = new Set(initialTarget.workspaceIds);
      let target = initialTarget;
      while (true) {
        await lifecycleCoordinator.waitForWorkspaceSetups(closureWorkspaceIds);
        await lifecycleCoordinator.waitForWorkspaceOwnershipMutations(closureWorkspaceIds);

        const refreshedTarget = await resolveArchiveTarget(dependencies, request.scope);
        archiveReservation.add(refreshedTarget.workspaceIds);
        target = mergeArchiveTargets(target, refreshedTarget);

        const newlyDiscoveredWorkspaceIds = refreshedTarget.workspaceIds.filter(
          (workspaceId) => !closureWorkspaceIds.has(workspaceId),
        );
        if (newlyDiscoveredWorkspaceIds.length === 0) {
          return archiveResolvedTarget(dependencies, lifecycleCoordinator, request, target);
        }
        for (const workspaceId of newlyDiscoveredWorkspaceIds) {
          closureWorkspaceIds.add(workspaceId);
        }
      }
    };
    try {
      const mutationRoot =
        (await resolveWorktreeMutationRoot(dependencies, initialTarget.backing)) ??
        (request.scope.kind === "worktree" ? dirname(resolve(request.scope.targetPath)) : null);
      return await (mutationRoot
        ? lifecycleCoordinator.runWorktreeMutationExclusive(mutationRoot, archiveOperation)
        : archiveOperation());
    } finally {
      archiveReservation.release();
    }
  });
}

async function resolveWorktreeMutationRoot(
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
  backing: BackingDirectory | null,
): Promise<string | null> {
  if (!backing?.isPaseoOwnedWorktree) return null;
  if (backing.paseoWorktreesRoot) return resolve(backing.paseoWorktreesRoot);
  if (backing.mainRepoRoot) {
    return resolve(
      await getPaseoWorktreesRoot(
        backing.mainRepoRoot,
        dependencies.paseoHome,
        dependencies.paseoWorktreesBaseRoot,
      ),
    );
  }
  return dirname(backing.path);
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

    const { archivedAgents, archivedWorkspaceIds, failures } = await archiveTargetRecords(
      dependencies,
      targetWorkspaceIds,
      request.requestId,
    );
    await clearCleanupPendingForUnarchivedTargets(dependencies, target, archivedWorkspaceIds);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to archive one or more workspaces");
    }

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

    const cleanupPendingWorkspaceIds = await getCleanupPendingWorkspaceIds(dependencies, target);

    return {
      archivedAgentIds: Array.from(archivedAgents),
      archivedWorkspaceIds,
      removedDirectory,
      cleanupPendingWorkspaceIds,
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
  if (targetWorkspaces.length > 0 || (pendingRecords && pendingRecords.length > 0)) {
    const activeWorkspaceIds = new Set(targetWorkspaces.map((workspace) => workspace.workspaceId));
    teardownTargets = targetWorkspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
    }));
    teardownTargets.push(
      ...(pendingRecords ?? []).flatMap((workspace) => {
        if (!workspace.cleanupPending || activeWorkspaceIds.has(workspace.workspaceId)) return [];
        return [
          {
            workspaceId: workspace.workspaceId,
            cwd: workspace.cleanupPending.teardownCwd,
          },
        ];
      }),
    );
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
): Promise<{
  archivedAgents: Set<string>;
  archivedWorkspaceIds: string[];
  failures: unknown[];
}> {
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
        "archiveByScope workspace teardown failed",
      );
    }
  }

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  return { archivedAgents, archivedWorkspaceIds, failures };
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

  const initialIncarnationState = await compareCleanupIncarnation(
    dependencies,
    backing,
    pendingCleanupTargets,
  );
  if (initialIncarnationState !== "match") {
    if (initialIncarnationState === "mismatch") {
      await clearPendingCleanup(dependencies, pendingCleanupTargets);
    }
    return false;
  }

  const activeBeforeTeardown = await dependencies.listActiveWorkspaces();
  if (
    !(await isDirectoryUnreferenced(
      activeBeforeTeardown,
      backing.path,
      new Set(archivedWorkspaceIds),
      dependencies,
    ))
  ) {
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
      throw error;
    }
    throw error;
  }

  const finalIncarnationState = await compareCleanupIncarnation(
    dependencies,
    backing,
    pendingCleanupTargets,
  );
  if (finalIncarnationState !== "match") {
    if (finalIncarnationState === "mismatch") {
      await clearPendingCleanup(dependencies, pendingCleanupTargets);
    }
    return false;
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
      throw error;
    }
    throw error;
  }
}

async function compareCleanupIncarnation(
  dependencies: Pick<ArchiveDependencies, "sessionLogger">,
  backing: BackingDirectory,
  pendingCleanupTargets: PendingCleanupTarget[],
): Promise<"match" | "mismatch" | "unverifiable"> {
  const expectedIncarnations = new Set(
    pendingCleanupTargets
      .map((target) => target.worktreeIncarnationId)
      .filter((value): value is string => value !== null),
  );
  if (
    expectedIncarnations.size !== 1 ||
    pendingCleanupTargets.some((target) => !target.worktreeIncarnationId)
  ) {
    dependencies.sessionLogger?.warn(
      { targetPath: backing.path },
      "Refusing path-only or conflicting persisted worktree cleanup",
    );
    return "unverifiable";
  }
  let currentIncarnationId: string | null = null;
  try {
    currentIncarnationId = readPaseoWorktreeIncarnationId(backing.path);
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, targetPath: backing.path },
      "Could not verify persisted worktree cleanup incarnation",
    );
    return "unverifiable";
  }
  if (currentIncarnationId === null) return "unverifiable";
  return expectedIncarnations.has(currentIncarnationId) ? "match" : "mismatch";
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
  // A target reconstructed from an archived record's cleanupPending state has
  // no active workspace ids. Its incarnation is the authority for this retry:
  // never rebind that stale cleanup intent to whatever now occupies the path.
  const activeTargetWorkspaceIds = new Set(target.workspaceIds);

  const worktreeIncarnationId = existsSync(backing.path)
    ? ensurePaseoWorktreeIncarnationId(backing.path)
    : null;

  await Promise.all(
    target.teardownTargets.flatMap((teardownTarget) =>
      teardownTarget.workspaceId && activeTargetWorkspaceIds.has(teardownTarget.workspaceId)
        ? [
            workspaceRegistry.update(teardownTarget.workspaceId, (workspace) => ({
              ...workspace,
              cleanupPending: {
                directoryPath: backing.path,
                teardownCwd: teardownTarget.cwd,
                mainRepoRoot: backing.mainRepoRoot,
                paseoWorktreesRoot: backing.paseoWorktreesRoot,
                worktreeIncarnationId,
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
    const targetWorkspaceIds = new Set(
      target.teardownTargets.flatMap((teardownTarget) =>
        teardownTarget.workspaceId ? [teardownTarget.workspaceId] : [],
      ),
    );
    const records = await workspaceRegistry.list();
    return records.flatMap((workspace) => {
      const cleanupPending = workspace.cleanupPending;
      if (
        (targetWorkspaceIds.size > 0 && !targetWorkspaceIds.has(workspace.workspaceId)) ||
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
  let fallbackIncarnationId: string | null = null;
  if (target.backing && existsSync(target.backing.path)) {
    try {
      fallbackIncarnationId = readPaseoWorktreeIncarnationId(target.backing.path);
    } catch {
      fallbackIncarnationId = null;
    }
  }
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
      worktreeIncarnationId: fallbackIncarnationId,
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
              worktreeIncarnationId: null,
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

  const storedRecords: StoredAgentRecord[] = await dependencies.agentStorage.list();
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));
  const matchingStoredRecords = storedRecords.filter(
    (record) => record.workspaceId === workspaceId,
  );
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
  }

  const archivedAt = new Date().toISOString();
  await Promise.all([
    ...liveAgents.map((agent) => dependencies.agentManager.archiveAgent(agent.id)),
    ...matchingStoredRecords
      .filter((record) => !liveAgentIds.has(record.id) && !record.archivedAt)
      .map((record) => dependencies.agentManager.archiveSnapshot(record.id, archivedAt)),
    dependencies.killTerminalsForWorkspace(workspaceId),
  ]);

  const remainingLiveAgents = dependencies.agentManager
    .listAgents()
    .filter((agent) => agent.workspaceId === workspaceId);
  const remainingStoredAgents = (await dependencies.agentStorage.list()).filter(
    (record) => record.workspaceId === workspaceId && !record.archivedAt,
  );
  if (remainingLiveAgents.length > 0 || remainingStoredAgents.length > 0) {
    throw new Error(`Workspace ownership remains after archive: ${workspaceId}`);
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

  const listWorkspaceTerminals = async () =>
    (
      await Promise.all(
        terminalManager
          .listDirectories()
          .map((terminalCwd) => terminalManager.getTerminals(terminalCwd, { workspaceId })),
      )
    )
      .flat()
      .filter((terminal) => terminal.workspaceId === workspaceId);
  const terminalIds: string[] = [];
  const terminalLists = [await listWorkspaceTerminals()];
  for (const terminals of terminalLists) {
    for (const terminal of terminals) {
      if (terminal.workspaceId === workspaceId) {
        terminalIds.push(terminal.id);
      }
    }
  }

  await Promise.all(
    terminalIds.map(async (terminalId) => {
      dependencies.detachTerminalStream?.(terminalId, { emitExit: true });
      await terminalManager.killTerminalAndWait(terminalId, {
        gracefulTimeoutMs: 2000,
        forceTimeoutMs: 1500,
      });
    }),
  );
  if ((await listWorkspaceTerminals()).length > 0) {
    throw new Error(`Workspace terminals remain after archive: ${workspaceId}`);
  }
}

async function getCleanupPendingWorkspaceIds(
  dependencies: Pick<ArchiveDependencies, "workspaceRegistry">,
  target: ArchiveTarget,
): Promise<string[]> {
  if (!dependencies.workspaceRegistry || !target.backing) return [];
  const matchesBacking = createRealpathAwarePathMatcher(target.backing.path);
  return (await dependencies.workspaceRegistry.list())
    .filter(
      (workspace) =>
        workspace.cleanupPending !== null && matchesBacking(workspace.cleanupPending.directoryPath),
    )
    .map((workspace) => workspace.workspaceId);
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
