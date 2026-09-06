import { resolve } from "node:path";

import type { Logger } from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

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
  PersistedWorkspaceRecord,
  WorkspaceArchiveContext,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";
import { WorkspaceAutomationBlockedError } from "./workspace-automation-gate.js";

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
  agentManager: Pick<AgentManager, "listAgents" | "getAgent" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "listByWorkspace" | "listDescendants" | "get" | "updateRecord">;
  // Resolves the worktree at a path to its workspaceId for archive-by-path. The
  // path uniquely identifies a worktree workspace; this is a directory lookup for
  // the archive target, not status/ownership.
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  getWorkspace?: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
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
  stopWorkspaceSetup?: (workspaceId: string) => Promise<void>;
  assertWorkspaceAutomationAllowed?: (workspaceId: string) => Promise<void>;
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
  setupWorkspaceIds: string[];
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
  return runWithGitCommandPriority("high", () => archiveByScopeWithPriority(dependencies, request));
}

async function archiveByScopeWithPriority(
  dependencies: ArchiveDependencies,
  request: ArchiveByScopeRequest,
): Promise<ArchiveResult> {
  const target = await resolveArchiveTarget(dependencies, request.scope);
  const targetWorkspaceIds = target.workspaceIds;

  await stopWorkspaceSetups(dependencies, target.setupWorkspaceIds, request.requestId);

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
      targetWorkspaceIds,
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
    const record =
      (await dependencies.getWorkspace?.(workspaceId)) ??
      activeWorkspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) {
      dependencies.sessionLogger?.warn(
        { workspaceId },
        "Workspace not found for archive-by-scope; skipping",
      );
      return { backing: null, teardownTargets: [], setupWorkspaceIds: [], workspaceIds: [] };
    }
    const isArchived = "archivedAt" in record && Boolean(record.archivedAt);
    return {
      backing: await resolveWorkspaceBackingDirectory(record, dependencies),
      teardownTargets: isArchived ? [] : [{ workspaceId, cwd: record.cwd }],
      setupWorkspaceIds: [workspaceId],
      workspaceIds: isArchived ? [] : [workspaceId],
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
    setupWorkspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
    workspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
  };
}

async function stopWorkspaceSetups(
  dependencies: ArchiveDependencies,
  workspaceIds: string[],
  requestId: string,
): Promise<void> {
  if (!dependencies.stopWorkspaceSetup) {
    return;
  }
  const results = await Promise.allSettled(
    workspaceIds.map((workspaceId) => dependencies.stopWorkspaceSetup!(workspaceId)),
  );
  for (const [index, result] of results.entries()) {
    if (result?.status === "rejected") {
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId: workspaceIds[index], requestId },
        "Failed to stop workspace setup during archive; continuing",
      );
    }
  }
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
  request: Pick<ArchiveByScopeRequest, "requestId">,
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<boolean> {
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree) {
    return false;
  }

  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  const teardownTargets = target.teardownTargets.filter(
    (teardownTarget) =>
      teardownTarget.workspaceId === null || archivedWorkspaceIdSet.has(teardownTarget.workspaceId),
  );

  try {
    const allowedTeardownTargets = await filterAllowedTeardownTargets(
      dependencies,
      teardownTargets,
    );
    for (const teardownTarget of uniqueTeardownTargets(allowedTeardownTargets)) {
      await runWorktreeTeardownCommands({
        worktreePath: backing.path,
        teardownCwd: teardownTarget.cwd,
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
    return true;
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, targetPath: backing.path, requestId: request.requestId },
      "Worktree disk removal failed during archive; workspace already archived",
    );
    return false;
  }
}

async function filterAllowedTeardownTargets(
  dependencies: ArchiveDependencies,
  targets: Array<{ workspaceId: string | null; cwd: string }>,
): Promise<Array<{ workspaceId: string | null; cwd: string }>> {
  const allowed: Array<{ workspaceId: string | null; cwd: string }> = [];
  const blockedCwds: string[] = [];
  for (const target of targets) {
    try {
      if (target.workspaceId)
        await dependencies.assertWorkspaceAutomationAllowed?.(target.workspaceId);
      allowed.push(target);
    } catch (error) {
      if (!(error instanceof WorkspaceAutomationBlockedError)) throw error;
      blockedCwds.push(target.cwd);
    }
  }
  return allowed.filter(
    (target) => !blockedCwds.some((cwd) => createRealpathAwarePathMatcher(cwd)(target.cwd)),
  );
}

function uniqueTeardownTargets<T extends { cwd: string }>(targets: T[]): T[] {
  const unique: T[] = [];
  for (const candidate of targets) {
    if (!unique.some((existing) => createRealpathAwarePathMatcher(existing.cwd)(candidate.cwd))) {
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

  let matchingStoredRecords: StoredAgentRecord[] = [];
  let storedRecords: StoredAgentRecord[] = [];
  try {
    matchingStoredRecords = await dependencies.agentStorage.listByWorkspace(workspaceId);
    const descendants = await dependencies.agentStorage.listDescendants([
      ...liveAgents.map((agent) => agent.id),
      ...matchingStoredRecords.map((record) => record.id),
    ]);
    storedRecords = [...matchingStoredRecords, ...descendants];
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, workspaceId },
      "Failed to list stored agents during workspace archive; continuing",
    );
  }
  const liveAgentIds = new Set(liveAgents.map((agent) => agent.id));
  const storedRecordsById = new Map(storedRecords.map((record) => [record.id, record]));
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
  }

  const snapshotsToArchive = matchingStoredRecords.filter(
    (record) => !liveAgentIds.has(record.id) && !record.archivedAt,
  );
  // Exactly the agents this gesture takes from unarchived to archived. Agents the
  // user archived individually beforehand are excluded so workspace restore leaves
  // them where the user put them.
  const cascadedAgentIds = findWorkspaceCascadeAgentIds(
    storedRecords,
    liveAgents
      .filter((agent) => !storedRecordsById.get(agent.id)?.archivedAt)
      .map((agent) => agent.id),
    snapshotsToArchive.map((record) => record.id),
  );
  for (const agentId of cascadedAgentIds) {
    archivedAgents.add(agentId);
  }

  const archivedAt = new Date().toISOString();
  const agentIdsToArchive = new Set([
    ...liveAgents.map((agent) => agent.id),
    ...matchingStoredRecords.filter((record) => !record.archivedAt).map((record) => record.id),
    ...cascadedAgentIds,
  ]);
  const archiveResults = await Promise.allSettled([
    ...[...agentIdsToArchive].map((agentId) =>
      dependencies.agentManager.getAgent(agentId)
        ? dependencies.agentManager.archiveAgent(agentId)
        : dependencies.agentManager.archiveSnapshot(agentId, archivedAt),
    ),
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

  await stampCascadeArchivedAgents(dependencies, cascadedAgentIds, workspaceId);

  return archivedAgents;
}

function findWorkspaceCascadeAgentIds(
  storedRecords: readonly StoredAgentRecord[],
  ...rootIdGroups: ReadonlyArray<readonly string[]>
): string[] {
  const initiallyUnarchivedIds = new Set(
    storedRecords.filter((record) => !record.archivedAt).map((record) => record.id),
  );
  const childrenByParent = new Map<string, string[]>();
  for (const record of storedRecords) {
    const parentId = record.labels?.[PARENT_AGENT_ID_LABEL];
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(record.id);
    childrenByParent.set(parentId, children);
  }

  const archivedByWorkspace = new Set(rootIdGroups.flat());
  const pending = [...archivedByWorkspace];
  while (pending.length > 0) {
    const parentId = pending.pop();
    if (!parentId) continue;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      // AgentManager's cascade skips an already-archived child and therefore does
      // not reach descendants beneath that child either.
      if (!initiallyUnarchivedIds.has(childId) || archivedByWorkspace.has(childId)) {
        continue;
      }
      archivedByWorkspace.add(childId);
      pending.push(childId);
    }
  }

  return [...archivedByWorkspace];
}

// Marks the records this gesture archived so `unarchiveWorkspaceContents` can find
// them again. Runs AFTER the archive fan-out on purpose: `archiveAgent` rebuilds the
// record (and cascade-archives children concurrently), so a stamp written inline
// would be overwritten by the archive projection.
async function stampCascadeArchivedAgents(
  dependencies: ArchiveWorkspaceContentsDependencies,
  agentIds: readonly string[],
  workspaceId: string,
): Promise<void> {
  const results = await Promise.allSettled(
    agentIds.map(async (agentId) =>
      // Read-modify-write inside the storage write queue: `archiveAgent` closes the
      // agent, which fires an un-awaited background persist, so reading the record
      // out here could hand us a stale copy and clobber that persist on write-back.
      dependencies.agentStorage.updateRecord(agentId, (record) => {
        // Only stamp what actually ended up archived; a failed archive step must not
        // leave a stamp that a later restore would act on.
        if (!record.archivedAt || record.archivedWithWorkspaceId === workspaceId) {
          return null;
        }
        return { ...record, archivedWithWorkspaceId: workspaceId };
      }),
    ),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId },
        "Failed to stamp workspace-archived agent; workspace restore will skip it",
      );
    }
  }
}

export interface UnarchiveWorkspaceContentsDependencies {
  agentManager: Pick<AgentManager, "archiveSnapshot" | "unarchiveSnapshot">;
  agentStorage: Pick<AgentStorage, "listByArchivedWorkspace" | "get" | "updateRecord">;
  sessionLogger?: Logger;
}

async function rollbackWorkspaceContents(
  dependencies: UnarchiveWorkspaceContentsDependencies,
  workspaceId: string,
  records: readonly StoredAgentRecord[],
): Promise<void> {
  const archivedAt = new Date().toISOString();
  const failures: unknown[] = [];

  for (const record of records) {
    const runRollbackStep = async (step: () => Promise<unknown>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
        dependencies.sessionLogger?.error(
          { err: error, workspaceId, agentId: record.id },
          "Failed to roll back agent during workspace restore",
        );
      }
    };

    // Stamp both before and after archiving. Either successful write preserves
    // the retry marker, including when the archive step itself fails.
    await runRollbackStep(() =>
      dependencies.agentStorage.updateRecord(record.id, (current) => ({
        ...current,
        archivedWithWorkspaceId: workspaceId,
      })),
    );
    await runRollbackStep(() =>
      dependencies.agentManager.archiveSnapshot(record.id, archivedAt, {
        nativeArchiveMode: "required",
      }),
    );
    await runRollbackStep(() =>
      dependencies.agentStorage.updateRecord(record.id, (current) => ({
        ...current,
        archivedWithWorkspaceId: workspaceId,
      })),
    );
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to roll back ${failures.length} agent(s) for workspace ${workspaceId}`,
    );
  }
}

function workspaceRestoreError(
  workspaceId: string,
  cause: unknown,
  rollbackError?: unknown,
): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  if (!rollbackError) {
    return new Error(`Failed to restore workspace ${workspaceId}${detail}`, { cause });
  }
  const rollbackDetail = rollbackError instanceof Error ? `: ${rollbackError.message}` : "";
  return new AggregateError(
    [cause, rollbackError],
    `Failed to restore workspace ${workspaceId}${detail}; rollback also failed${rollbackDetail}`,
  );
}

// Inverse of `archiveWorkspaceContents`: restores exactly the agents that were
// archived as part of archiving this workspace (stamped with
// `archivedWithWorkspaceId`). Agents archived individually before the workspace was
// archived carry no stamp and stay archived. Goes through
// `AgentManager.unarchiveSnapshot` so the provider's native unarchive hook (e.g.
// Codex `thread/unarchive`) runs, and so the stamp is cleared.
// Returns the restored records so the caller can publish them to clients.
export async function unarchiveWorkspaceContents(
  dependencies: UnarchiveWorkspaceContentsDependencies,
  workspaceId: string,
): Promise<StoredAgentRecord[]> {
  let storedRecords: StoredAgentRecord[] = [];
  try {
    storedRecords = await dependencies.agentStorage.listByArchivedWorkspace(workspaceId);
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, workspaceId },
      "Failed to list stored agents during workspace unarchive",
    );
    throw error;
  }

  // A stamped active record means a previous rollback failed after preserving
  // its retry marker. Treat it as already restored so this attempt can converge
  // by activating the workspace or rolling the record back again.
  const candidates = storedRecords;
  if (candidates.length === 0) {
    return [];
  }

  const restored: StoredAgentRecord[] = [];
  try {
    for (const candidate of candidates) {
      if (candidate.archivedAt) {
        const unarchived = await dependencies.agentManager.unarchiveSnapshot(candidate.id);
        if (!unarchived) {
          throw new Error(`Stamped agent was not archived: ${candidate.id}`);
        }
        restored.push(candidate);
      } else {
        restored.push(candidate);
        await dependencies.agentStorage.updateRecord(candidate.id, (current) => ({
          ...current,
          archivedWithWorkspaceId: null,
        }));
      }
      const record = await dependencies.agentStorage.get(candidate.id);
      if (!record) {
        throw new Error(`Restored agent disappeared from storage: ${candidate.id}`);
      }
      restored[restored.length - 1] = record;
    }
  } catch (cause) {
    dependencies.sessionLogger?.warn(
      { err: cause, workspaceId },
      "Failed to unarchive agent during workspace restore; rolling back restored agents",
    );
    try {
      await rollbackWorkspaceContents(dependencies, workspaceId, restored);
    } catch (rollbackError) {
      throw workspaceRestoreError(workspaceId, cause, rollbackError);
    }
    throw workspaceRestoreError(workspaceId, cause);
  }

  return restored;
}

export async function unarchiveWorkspaceContentsAndActivate(
  dependencies: UnarchiveWorkspaceContentsDependencies,
  workspaceId: string,
  activateWorkspace: () => Promise<void>,
): Promise<StoredAgentRecord[]> {
  const restored = await unarchiveWorkspaceContents(dependencies, workspaceId);
  try {
    await activateWorkspace();
    return restored;
  } catch (cause) {
    dependencies.sessionLogger?.warn(
      { err: cause, workspaceId },
      "Failed to activate workspace after restoring agents; rolling back restored agents",
    );
    try {
      await rollbackWorkspaceContents(dependencies, workspaceId, restored);
    } catch (rollbackError) {
      throw workspaceRestoreError(workspaceId, cause, rollbackError);
    }
    throw workspaceRestoreError(workspaceId, cause);
  }
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
