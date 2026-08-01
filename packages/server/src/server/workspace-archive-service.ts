import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  deletePaseoWorktree,
  hasPaseoWorktreeCleanupQuarantine,
  isPaseoOwnedWorktreeCwd,
  runWorktreeTeardownCommands,
  WorktreeCleanupRelocatedError,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type {
  PersistedWorkspaceRecord,
  PersistedWorkspaceCleanupReceipt,
  WorkspaceArchiveContext,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { workspaceCleanupReceiptToken } from "./workspace-registry.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { withWorkspaceCleanupLock } from "./workspace-cleanup-lock.js";

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
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "update">;
  archiveWorkspaceRecord: (workspaceId: string, context?: WorkspaceArchiveContext) => Promise<void>;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  sessionLogger?: Logger;
  deleteWorktree?: typeof deletePaseoWorktree;
  runTeardownCommands?: typeof runWorktreeTeardownCommands;
  now?: () => Date;
}

export interface KillTerminalsForWorkspaceDependencies {
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
}

export type ArchiveScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "worktree"; targetPath: string }
  | {
      kind: "cleanup";
      workspaceId: string;
      receipt: PersistedWorkspaceCleanupReceipt;
    };

export interface ArchiveResult {
  archivedAgentIds: string[];
  archivedWorkspaceIds: string[];
  removedDirectory: boolean;
  cleanupPending: boolean;
}

export interface ArchiveByScopeRequest {
  scope: ArchiveScope;
  requestId: string;
  signal?: AbortSignal;
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

  const persisted = await dependencies.workspaceRegistry.get(workspaceId);
  if (!persisted?.archivedAt || !persisted.cleanupPending) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return persisted;
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
  cleanupWorkspaceIds: string[];
  selectedCleanupReceipt: { workspaceId: string; token: string } | null;
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
  const target = await resolveArchiveTarget(dependencies, request.scope);
  if (target.backing?.isPaseoOwnedWorktree) {
    return withWorkspaceCleanupLock(dirname(target.backing.path), () =>
      withWorkspaceCleanupLock(target.backing!.path, () =>
        archiveResolvedTarget(dependencies, request, target),
      ),
    );
  }
  return archiveResolvedTarget(dependencies, request, target);
}

async function archiveResolvedTarget(
  dependencies: ArchiveDependencies,
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

    const { archivedAgents, archivedWorkspaceIds } = await archiveTargetRecords(
      dependencies,
      target,
      request.requestId,
    );

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
        request,
        target,
        archivedWorkspaceIds,
      );
    }

    return {
      archivedAgentIds: Array.from(archivedAgents),
      archivedWorkspaceIds,
      removedDirectory,
      cleanupPending: await hasPendingCleanup(dependencies, target.cleanupWorkspaceIds),
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

  if (scope.kind === "cleanup") {
    const persisted = await dependencies.workspaceRegistry.get(scope.workspaceId);
    if (
      !persisted?.archivedAt ||
      !persisted.cleanupPending ||
      workspaceCleanupReceiptToken(persisted.cleanupPending) !==
        workspaceCleanupReceiptToken(scope.receipt)
    ) {
      return {
        backing: null,
        teardownTargets: [],
        workspaceIds: [],
        cleanupWorkspaceIds: [],
        selectedCleanupReceipt: null,
      };
    }
    const receipt = persisted.cleanupPending;
    return {
      backing: {
        path: receipt.backingPath,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: receipt.mainRepoRoot,
        paseoWorktreesRoot: receipt.paseoWorktreesRoot,
      },
      teardownTargets: receipt.teardownCwds.map((cwd) => ({ workspaceId: null, cwd })),
      workspaceIds: [],
      cleanupWorkspaceIds: [scope.workspaceId],
      selectedCleanupReceipt: {
        workspaceId: scope.workspaceId,
        token: workspaceCleanupReceiptToken(receipt),
      },
    };
  }

  if (scope.kind === "workspace") {
    const workspaceId = scope.workspaceId;
    const record = activeWorkspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) {
      const persisted = await dependencies.workspaceRegistry.get(workspaceId);
      if (persisted?.archivedAt && persisted.cleanupPending) {
        const receipt = persisted.cleanupPending;
        return {
          backing: {
            path: receipt.backingPath,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: receipt.mainRepoRoot,
            paseoWorktreesRoot: receipt.paseoWorktreesRoot,
          },
          teardownTargets: receipt.teardownCwds.map((cwd) => ({ workspaceId: null, cwd })),
          workspaceIds: [],
          cleanupWorkspaceIds: [workspaceId],
          selectedCleanupReceipt: {
            workspaceId,
            token: workspaceCleanupReceiptToken(receipt),
          },
        };
      }
      dependencies.sessionLogger?.warn(
        { workspaceId },
        "Workspace not found for archive-by-scope; skipping",
      );
      return {
        backing: null,
        teardownTargets: [],
        workspaceIds: [],
        cleanupWorkspaceIds: [],
        selectedCleanupReceipt: null,
      };
    }
    return {
      backing: await resolveWorkspaceBackingDirectory(record, dependencies),
      teardownTargets: [{ workspaceId, cwd: record.cwd }],
      workspaceIds: [workspaceId],
      cleanupWorkspaceIds: [workspaceId],
      selectedCleanupReceipt: null,
    };
  }

  const backing = await resolveBackingDirectory(scope.targetPath, dependencies);
  const matchesBackingDirectory = createRealpathAwarePathMatcher(backing.path);
  const targetWorkspaces = (
    await Promise.all(
      activeWorkspaces.map(async (workspace) => {
        const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
        return matchesBackingDirectory(backingDirectory.path) ? workspace : null;
      }),
    )
  ).filter((workspace): workspace is ActiveWorkspaceRef => workspace !== null);
  const persistedMainRepoRoot = targetWorkspaces.find(
    (workspace) => workspace.mainRepoRoot,
  )?.mainRepoRoot;
  return {
    backing: {
      ...backing,
      mainRepoRoot: persistedMainRepoRoot ?? backing.mainRepoRoot,
    },
    teardownTargets:
      targetWorkspaces.length > 0
        ? targetWorkspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            cwd: workspace.cwd,
          }))
        : [{ workspaceId: null, cwd: scope.targetPath }],
    workspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
    cleanupWorkspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
    selectedCleanupReceipt: null,
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
  target: ArchiveTarget,
  requestId: string,
): Promise<{ archivedAgents: Set<string>; archivedWorkspaceIds: string[] }> {
  const archivedAgents = new Set<string>();
  const archivedWorkspaceIds: string[] = [];
  const cleanupReceipts = await createCleanupReceipts(dependencies, target);

  const results = await Promise.allSettled(
    target.workspaceIds.map(async (workspaceId) => {
      const agents = await archiveWorkspaceContents(dependencies, workspaceId);
      const cleanupPending = cleanupReceipts.get(workspaceId);
      await dependencies.archiveWorkspaceRecord(
        workspaceId,
        cleanupPending ? { cleanupPending } : undefined,
      );
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
  request: Pick<ArchiveByScopeRequest, "requestId" | "signal">,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<boolean> {
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree) {
    return false;
  }
  if (!(await selectedCleanupReceiptIsCurrent(dependencies, target.selectedCleanupReceipt))) {
    return false;
  }

  const cleanupWorkspaceIds = await matchingCleanupWorkspaceIds(
    dependencies,
    target.cleanupWorkspaceIds,
  );
  if (target.cleanupWorkspaceIds.length > 0 && cleanupWorkspaceIds.length === 0) {
    return false;
  }
  await updateCleanupReceipts(dependencies, cleanupWorkspaceIds, (receipt) => ({
    ...receipt,
    lastAttemptAt: nowIso(dependencies),
    attemptCount: receipt.attemptCount + 1,
    lastError: null,
  }));

  const receiptIdentity =
    cleanupWorkspaceIds.length === 0
      ? undefined
      : await expectedDirectoryIdentity(dependencies, cleanupWorkspaceIds);
  const initialIdentity = await validateCleanupDirectoryIdentity(
    dependencies,
    request,
    cleanupWorkspaceIds,
    backing.path,
    receiptIdentity,
  );
  if (initialIdentity.status === "changed" || initialIdentity.status === "released") {
    return false;
  }
  const expectedIdentity =
    initialIdentity.status === "matched" || initialIdentity.status === "quarantined"
      ? initialIdentity.identity
      : receiptIdentity;

  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  const teardownCwds =
    cleanupWorkspaceIds.length > 0
      ? await cleanupTeardownCwds(dependencies, cleanupWorkspaceIds)
      : uniqueFilesystemPaths(
          target.teardownTargets
            .filter(
              (teardownTarget) =>
                teardownTarget.workspaceId === null ||
                archivedWorkspaceIdSet.has(teardownTarget.workspaceId),
            )
            .map((teardownTarget) => teardownTarget.cwd),
        );

  if (initialIdentity.status === "matched") {
    try {
      for (const teardownCwd of teardownCwds) {
        await (dependencies.runTeardownCommands ?? runWorktreeTeardownCommands)({
          worktreePath: backing.path,
          teardownCwd,
          repoRootPath: backing.mainRepoRoot ?? undefined,
          signal: request.signal,
        });
        await completeCleanupTeardown(dependencies, cleanupWorkspaceIds, teardownCwd);
      }
    } catch (error) {
      await recordCleanupFailure(dependencies, cleanupWorkspaceIds, errorMessage(error));
      dependencies.sessionLogger?.warn(
        { err: error, targetPath: backing.path, requestId: request.requestId },
        "Worktree teardown failed during archive; cleanup remains pending",
      );
      return false;
    }
  }

  return removeDirectoryUnderLock(
    dependencies,
    request,
    backing,
    archivedWorkspaceIds,
    cleanupWorkspaceIds,
    expectedIdentity,
  );
}

async function removeDirectoryUnderLock(
  dependencies: ArchiveDependencies,
  request: Pick<ArchiveByScopeRequest, "requestId" | "signal">,
  backing: BackingDirectory,
  archivedWorkspaceIds: string[],
  cleanupWorkspaceIds: string[],
  expectedIdentity: string | null | undefined,
): Promise<boolean> {
  const remainingActive = await dependencies.listActiveWorkspaces();
  if (
    !(await isDirectoryUnreferenced(
      remainingActive,
      backing.path,
      new Set(archivedWorkspaceIds),
      dependencies,
    ))
  ) {
    await clearCleanupReceipts(dependencies, cleanupWorkspaceIds);
    return false;
  }

  const identityAtRemoval = await validateCleanupDirectoryIdentity(
    dependencies,
    request,
    cleanupWorkspaceIds,
    backing.path,
    expectedIdentity,
  );
  if (identityAtRemoval.status === "changed" || identityAtRemoval.status === "released") {
    return false;
  }

  try {
    await (dependencies.deleteWorktree ?? deletePaseoWorktree)({
      cwd: backing.mainRepoRoot,
      worktreePath: backing.path,
      teardownCwds: [],
      worktreesRoot: backing.paseoWorktreesRoot ?? undefined,
      paseoHome: dependencies.paseoHome,
      worktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
      expectedDirectoryIdentity: expectedIdentity,
      signal: request.signal,
    });
    dependencies.github.invalidate({ cwd: backing.path });
    await clearCleanupReceipts(dependencies, cleanupWorkspaceIds);
    return true;
  } catch (error) {
    if (error instanceof WorktreeCleanupRelocatedError) {
      await updateCleanupReceipts(dependencies, cleanupWorkspaceIds, (receipt) => ({
        ...receipt,
        backingPath: error.remainingPath,
        directoryIdentity: error.directoryIdentity,
      }));
    }
    await recordCleanupFailure(dependencies, cleanupWorkspaceIds, errorMessage(error));
    dependencies.sessionLogger?.warn(
      { err: error, targetPath: backing.path, requestId: request.requestId },
      "Worktree disk removal failed during archive; cleanup remains pending",
    );
    return false;
  }
}

async function createCleanupReceipts(
  dependencies: ArchiveDependencies,
  target: ArchiveTarget,
): Promise<Map<string, PersistedWorkspaceCleanupReceipt>> {
  const receipts = new Map<string, PersistedWorkspaceCleanupReceipt>();
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree || target.workspaceIds.length === 0) {
    return receipts;
  }

  const directoryIdentity = await readDirectoryIdentity(backing.path);
  const createdAt = nowIso(dependencies);
  for (const workspaceId of target.workspaceIds) {
    const teardownCwds = uniqueFilesystemPaths(
      target.teardownTargets
        .filter((entry) => entry.workspaceId === null || entry.workspaceId === workspaceId)
        .map((entry) => entry.cwd),
    );
    receipts.set(workspaceId, {
      workspaceId,
      backingPath: backing.path,
      teardownCwds,
      mainRepoRoot: backing.mainRepoRoot,
      paseoWorktreesRoot: backing.paseoWorktreesRoot,
      directoryIdentity,
      createdAt,
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
    });
  }
  return receipts;
}

async function readDirectoryIdentity(directoryPath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(directoryPath);
    return `${stats.dev}:${stats.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

type CleanupDirectoryIdentityValidation =
  | { status: "matched"; identity: string }
  | { status: "quarantined"; identity: string }
  | { status: "missing" }
  | { status: "changed" }
  | { status: "released" };

async function validateCleanupDirectoryIdentity(
  dependencies: ArchiveDependencies,
  request: Pick<ArchiveByScopeRequest, "requestId">,
  cleanupWorkspaceIds: string[],
  directoryPath: string,
  expectedIdentity: string | null | undefined,
): Promise<CleanupDirectoryIdentityValidation> {
  if (
    cleanupWorkspaceIds.length > 0 &&
    !(await cleanupOwnershipRemainsArchived(dependencies, cleanupWorkspaceIds))
  ) {
    return { status: "released" };
  }
  const currentIdentity = await readDirectoryIdentity(directoryPath);
  if (currentIdentity === null) {
    return { status: "missing" };
  }
  if (expectedIdentity !== undefined && currentIdentity !== expectedIdentity) {
    if (
      expectedIdentity !== null &&
      (await hasPaseoWorktreeCleanupQuarantine(directoryPath, expectedIdentity))
    ) {
      return { status: "quarantined", identity: expectedIdentity };
    }
    await recordCleanupFailure(
      dependencies,
      cleanupWorkspaceIds,
      `Cleanup path identity changed for ${directoryPath}`,
    );
    dependencies.sessionLogger?.warn(
      { targetPath: directoryPath, requestId: request.requestId },
      "Refusing to remove a replaced worktree directory during archive cleanup",
    );
    return { status: "changed" };
  }
  return { status: "matched", identity: currentIdentity };
}

async function cleanupOwnershipRemainsArchived(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<boolean> {
  const workspaces = await Promise.all(
    workspaceIds.map((workspaceId) => dependencies.workspaceRegistry.get(workspaceId)),
  );
  return workspaces.every((workspace) =>
    Boolean(workspace?.archivedAt && workspace.cleanupPending),
  );
}

async function matchingCleanupWorkspaceIds(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<string[]> {
  const seeds = (
    await Promise.all(
      workspaceIds.map((workspaceId) => dependencies.workspaceRegistry.get(workspaceId)),
    )
  ).filter((workspace): workspace is PersistedWorkspaceRecord => workspace !== null);
  const keys = new Set(
    seeds.flatMap((workspace) =>
      workspace.cleanupPending ? [cleanupReceiptKey(workspace.cleanupPending)] : [],
    ),
  );
  if (keys.size === 0) {
    return [];
  }
  return (await dependencies.workspaceRegistry.list())
    .filter(
      (workspace) =>
        workspace.cleanupPending && keys.has(cleanupReceiptKey(workspace.cleanupPending)),
    )
    .map((workspace) => workspace.workspaceId);
}

function cleanupReceiptKey(receipt: PersistedWorkspaceCleanupReceipt): string {
  return `${resolve(receipt.backingPath)}\0${receipt.directoryIdentity ?? "missing"}`;
}

async function selectedCleanupReceiptIsCurrent(
  dependencies: ArchiveDependencies,
  selected: ArchiveTarget["selectedCleanupReceipt"],
): Promise<boolean> {
  if (!selected) return true;
  const workspace = await dependencies.workspaceRegistry.get(selected.workspaceId);
  return Boolean(
    workspace?.archivedAt &&
    workspace.cleanupPending &&
    workspaceCleanupReceiptToken(workspace.cleanupPending) === selected.token,
  );
}

async function expectedDirectoryIdentity(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<string | null> {
  for (const workspaceId of workspaceIds) {
    const workspace = await dependencies.workspaceRegistry.get(workspaceId);
    if (workspace?.cleanupPending) {
      return workspace.cleanupPending.directoryIdentity;
    }
  }
  return null;
}

async function cleanupTeardownCwds(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<string[]> {
  const workspaces = await Promise.all(
    workspaceIds.map((workspaceId) => dependencies.workspaceRegistry.get(workspaceId)),
  );
  return uniqueFilesystemPaths(
    workspaces.flatMap((workspace) => workspace?.cleanupPending?.teardownCwds ?? []),
  );
}

async function completeCleanupTeardown(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
  completedCwd: string,
): Promise<void> {
  await updateCleanupReceipts(dependencies, workspaceIds, (receipt) => ({
    ...receipt,
    teardownCwds: receipt.teardownCwds.filter(
      (cwd) => !createRealpathAwarePathMatcher(completedCwd)(cwd),
    ),
  }));
}

async function updateCleanupReceipts(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
  updater: (receipt: PersistedWorkspaceCleanupReceipt) => PersistedWorkspaceCleanupReceipt | null,
): Promise<void> {
  await Promise.all(
    workspaceIds.map((workspaceId) =>
      dependencies.workspaceRegistry.update(workspaceId, (workspace) => ({
        ...workspace,
        cleanupPending: workspace.cleanupPending ? updater(workspace.cleanupPending) : null,
      })),
    ),
  );
}

async function clearCleanupReceipts(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<void> {
  await updateCleanupReceipts(dependencies, workspaceIds, () => null);
}

async function recordCleanupFailure(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
  message: string,
): Promise<void> {
  await updateCleanupReceipts(dependencies, workspaceIds, (receipt) => ({
    ...receipt,
    lastError: message,
  }));
}

async function hasPendingCleanup(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
): Promise<boolean> {
  return (
    await Promise.all(
      workspaceIds.map((workspaceId) => dependencies.workspaceRegistry.get(workspaceId)),
    )
  ).some(
    (workspace) => workspace?.cleanupPending !== null && workspace?.cleanupPending !== undefined,
  );
}

function nowIso(dependencies: Pick<ArchiveDependencies, "now">): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  context?: WorkspaceArchiveContext;
}): Promise<PersistedWorkspaceRecord | null> {
  const existingWorkspace = await input.workspaceRegistry.get(input.workspaceId);
  if (!existingWorkspace) {
    return null;
  }

  if (existingWorkspace.archivedAt) {
    return existingWorkspace;
  }

  const archivedAt = input.archivedAt ?? new Date().toISOString();
  await input.workspaceRegistry.archive(input.workspaceId, archivedAt, input.context);

  return existingWorkspace;
}
