import { resolve } from "node:path";

import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  deletePaseoWorktree,
  readWorktreeHeadReference,
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
import { createRealpathAwarePathMatcher, isRealpathInsideRoot } from "../utils/path.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";
import {
  readPaseoWorktreeMetadata,
  setPaseoWorktreeUntrustedSource,
} from "../utils/worktree-metadata.js";
import {
  WorkspaceAutomationBlockedError,
  type UntrustedWorkspaceSource,
} from "./workspace-automation-gate.js";
import type { PluginWorktreeManagerRuntime } from "./plugins/runtime.js";
import type { WorkspaceArchiveOperations } from "./workspace-archive-operations.js";

export type ActiveWorkspaceRef = Pick<
  PersistedWorkspaceRecord,
  "workspaceId" | "cwd" | "kind" | "worktreeRoot" | "isPaseoOwnedWorktree" | "mainRepoRoot"
> & {
  worktreeManagerPluginId?: string | null;
  untrustedSource?: PersistedWorkspaceRecord["untrustedSource"];
};

export interface ArchiveDependencies {
  paseoHome?: string;
  // Base directory that may hold worktrees across repositories.
  paseoWorktreesBaseRoot?: string;
  worktreeManagers?: Pick<PluginWorktreeManagerRuntime, "removeWorktree">;
  workspaceArchiveOperations?: Pick<WorkspaceArchiveOperations, "withCheckout">;
  github: ForgeService;
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "invalidateWorktrees">;
  agentManager: Pick<AgentManager, "listAgents" | "getAgent" | "archiveAgent" | "archiveSnapshot">;
  agentStorage: Pick<AgentStorage, "listByWorkspace">;
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
  archiveWorkspaceRecord: (workspaceId: string, archivedAt: string) => Promise<void>;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  stopWorkspaceSetup?: (workspaceId: string) => Promise<void>;
  assertWorkspaceAutomationAllowed: (workspaceId: string) => Promise<void>;
  isCheckoutUntrusted: (checkoutPath: string) => Promise<boolean>;
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
  // Set when the record archived but its worktree directory was left on
  // disk because no ownership proof held for it. The directory is never
  // deleted in that case; the path and reason surface here and in the log.
  directoryLeftBehind?: { path: string; reason: string };
}

export interface ArchiveByScopeRequest {
  scope: ArchiveScope;
  requestId: string;
  // Aborting cancels the archive at its next checkpoint. Removing the worktree directory is the
  // point of no return: once it starts the archive completes.
  signal?: AbortSignal;
}

// Cancellation carries the operation stamp even before the workspace record is archived.
export class WorkspaceArchiveCanceledError extends Error {
  constructor(public readonly archivedAt: string) {
    super("Workspace archive was canceled");
    this.name = "WorkspaceArchiveCanceledError";
  }
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
  // True when the directory backs a worktree workspace (or a worktree-scope
  // archive), so a failed ownership proof means a Paseo worktree directory
  // is being left behind rather than a user's local checkout being ignored.
  expectsPaseoOwnership: boolean;
  // True only when this backing came from a workspace registry record
  // matched to this path (the record is itself an ownership proof, passed
  // through to deletePaseoWorktree). Disk-derived backings stay false:
  // they must prove ownership on disk.
  registryProven: boolean;
  mainRepoRoot: string | null;
  paseoWorktreesRoot: string | null;
  worktreeManagerPluginId: string | null;
  untrustedSource: UntrustedWorkspaceSource | null;
}

interface ArchiveTarget {
  backing: BackingDirectory | null;
  teardownTargets: Array<{ workspaceId: string; cwd: string }>;
  // Active workspaces sharing the resolved backing checkout when archive starts
  // (including the records being archived and any active siblings). Keeps
  // teardown approval scoped to the live checkout rather than historical
  // archived records that previously occupied the same path.
  checkoutWorkspaceIds: string[];
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

export async function resolveWorkspaceBackingPath(
  workspace: ActiveWorkspaceRef,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<string> {
  return (await resolveWorkspaceBackingDirectory(workspace, dependencies)).path;
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
  const archivedAt = new Date().toISOString();
  const checkpoint = () => {
    if (request.signal?.aborted) {
      throw new WorkspaceArchiveCanceledError(archivedAt);
    }
  };

  checkpoint();
  const runArchive = async (): Promise<ArchiveResult> => {
    checkpoint();
    const target = await resolveArchiveTarget(dependencies, request.scope);
    const targetWorkspaceIds = target.workspaceIds;

    await stopWorkspaceSetups(dependencies, target.setupWorkspaceIds, request.requestId);
    checkpoint();

    if (targetWorkspaceIds.length > 0) {
      dependencies.markWorkspaceArchiving(targetWorkspaceIds, new Date().toISOString());
    }

    let removedDirectory = false;
    let directoryLeftBehind: ArchiveResult["directoryLeftBehind"];

    try {
      if (targetWorkspaceIds.length > 0) {
        await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
      }
      checkpoint();

      const { archivedAgents, archivedWorkspaceIds } = await archiveTargetRecords(
        dependencies,
        targetWorkspaceIds,
        { requestId: request.requestId, checkpoint, archivedAt },
      );
      checkpoint();

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
        const removal = await maybeRemoveDirectory(
          dependencies,
          { requestId: request.requestId, checkpoint },
          target,
          archivedWorkspaceIds,
        );
        removedDirectory = removal.removedDirectory;
        directoryLeftBehind = removal.directoryLeftBehind;
      }

      return {
        archivedAgentIds: Array.from(archivedAgents),
        archivedWorkspaceIds,
        removedDirectory,
        ...(directoryLeftBehind ? { directoryLeftBehind } : {}),
      };
    } finally {
      if (targetWorkspaceIds.length > 0) {
        dependencies.clearWorkspaceArchiving(targetWorkspaceIds);
        await dependencies.emitWorkspaceUpdatesForWorkspaceIds(targetWorkspaceIds);
      }
    }
  };

  const checkoutPath = dependencies.workspaceArchiveOperations
    ? await resolveArchiveCheckoutPath(dependencies, request.scope)
    : null;
  if (dependencies.workspaceArchiveOperations && checkoutPath) {
    return dependencies.workspaceArchiveOperations.withCheckout(checkoutPath, runArchive);
  }
  return runArchive();
}

async function resolveArchiveCheckoutPath(
  dependencies: ArchiveDependencies,
  scope: ArchiveScope,
): Promise<string | null> {
  if (scope.kind === "workspace") {
    const record =
      (await dependencies.getWorkspace?.(scope.workspaceId)) ??
      (await dependencies.listActiveWorkspaces()).find(
        (workspace) => workspace.workspaceId === scope.workspaceId,
      );
    if (!record) {
      return null;
    }
    return resolveWorkspaceBackingPath(record, dependencies);
  }
  return (await resolveBackingDirectory(scope.targetPath, dependencies)).path;
}

async function listActiveWorkspacesOnBacking(
  activeWorkspaces: ActiveWorkspaceRef[],
  backingPath: string,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<ActiveWorkspaceRef[]> {
  const matchesBackingDirectory = createRealpathAwarePathMatcher(backingPath);
  return (
    await Promise.all(
      activeWorkspaces.map(async (workspace) => {
        const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
        return matchesBackingDirectory(backingDirectory.path) ? workspace : null;
      }),
    )
  ).filter((workspace): workspace is ActiveWorkspaceRef => workspace !== null);
}

function firstUntrustedSource(
  primary: UntrustedWorkspaceSource | null,
  workspaces: ActiveWorkspaceRef[],
): UntrustedWorkspaceSource | null {
  return (
    primary ??
    workspaces.find((workspace) => Boolean(workspace.untrustedSource))?.untrustedSource ??
    null
  );
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
      return {
        backing: null,
        teardownTargets: [],
        checkoutWorkspaceIds: [],
        setupWorkspaceIds: [],
        workspaceIds: [],
      };
    }
    const isArchived = "archivedAt" in record && Boolean(record.archivedAt);
    const backing = await resolveWorkspaceBackingDirectory(record, dependencies);
    const activeOnCheckout = await listActiveWorkspacesOnBacking(
      activeWorkspaces,
      backing.path,
      dependencies,
    );
    const checkoutWorkspaceIds = Array.from(
      new Set([
        ...(isArchived ? [] : [workspaceId]),
        ...activeOnCheckout.map((workspace) => workspace.workspaceId),
      ]),
    );
    return {
      backing: {
        ...backing,
        untrustedSource: firstUntrustedSource(
          isArchived ? null : backing.untrustedSource,
          activeOnCheckout,
        ),
      },
      teardownTargets: isArchived ? [] : [{ workspaceId, cwd: record.cwd }],
      checkoutWorkspaceIds,
      setupWorkspaceIds: [workspaceId],
      workspaceIds: isArchived ? [] : [workspaceId],
    };
  }

  const backing = await resolveBackingDirectory(scope.targetPath, dependencies);
  const matchesBackingDirectory = createRealpathAwarePathMatcher(backing.path);
  const targetWorkspaces = await listActiveWorkspacesOnBacking(
    activeWorkspaces,
    backing.path,
    dependencies,
  );
  const recordedId = await dependencies.findWorkspaceIdForCwd(backing.path);
  const recorded = recordedId ? await dependencies.getWorkspace?.(recordedId) : null;
  const record =
    targetWorkspaces.find((workspace) => workspace.kind === "worktree") ??
    (recorded && matchesBackingDirectory(recorded.worktreeRoot ?? recorded.cwd)
      ? recorded
      : null) ??
    targetWorkspaces[0];
  const resolvedBacking = record
    ? await resolveWorkspaceBackingDirectory(record, dependencies)
    : backing;
  return {
    backing: {
      ...resolvedBacking,
      untrustedSource: firstUntrustedSource(null, targetWorkspaces),
    },
    teardownTargets: targetWorkspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
    })),
    checkoutWorkspaceIds: targetWorkspaces.map((workspace) => workspace.workspaceId),
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
  const worktreeManagerPluginId = workspace.worktreeManagerPluginId ?? null;
  const untrustedSource = workspace.untrustedSource ?? null;
  if (workspace.isPaseoOwnedWorktree === false) {
    return {
      path: resolve(workspace.worktreeRoot ?? workspace.cwd),
      isPaseoOwnedWorktree: false,
      expectsPaseoOwnership: false,
      registryProven: false,
      mainRepoRoot: workspace.mainRepoRoot ?? null,
      paseoWorktreesRoot: null,
      worktreeManagerPluginId,
      untrustedSource,
    };
  }
  if (workspace.isPaseoOwnedWorktree && workspace.worktreeRoot && workspace.mainRepoRoot) {
    return {
      path: resolve(workspace.worktreeRoot),
      isPaseoOwnedWorktree: true,
      expectsPaseoOwnership: true,
      registryProven: true,
      mainRepoRoot: workspace.mainRepoRoot,
      paseoWorktreesRoot: null,
      worktreeManagerPluginId,
      untrustedSource,
    };
  }
  if (workspace.kind !== "worktree") {
    return {
      path: resolve(workspace.cwd),
      isPaseoOwnedWorktree: false,
      expectsPaseoOwnership: false,
      registryProven: false,
      mainRepoRoot: workspace.mainRepoRoot ?? null,
      paseoWorktreesRoot: null,
      worktreeManagerPluginId,
      untrustedSource,
    };
  }

  // COMPAT(archiveMissingWorkspacePlacement): worktree records created before v0.1.110
  // lack durable backing ownership; remove filesystem discovery after 2027-01-17.
  const backing = await resolveBackingDirectory(
    workspace.worktreeRoot ?? workspace.cwd,
    dependencies,
  );
  return {
    ...backing,
    mainRepoRoot: workspace.mainRepoRoot ?? backing.mainRepoRoot,
    worktreeManagerPluginId: worktreeManagerPluginId ?? backing.worktreeManagerPluginId,
    untrustedSource: untrustedSource ?? backing.untrustedSource,
  };
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
    expectsPaseoOwnership: true,
    registryProven: false,
    mainRepoRoot: ownership.repoRoot ?? null,
    paseoWorktreesRoot: ownership.worktreeRoot ?? null,
    worktreeManagerPluginId: null,
    untrustedSource: null,
  };
}

async function archiveTargetRecords(
  dependencies: ArchiveDependencies,
  targetWorkspaceIds: string[],
  options: {
    requestId: string;
    checkpoint: () => void;
    archivedAt: string;
  },
): Promise<{ archivedAgents: Set<string>; archivedWorkspaceIds: string[] }> {
  const archivedAgents = new Set<string>();
  const archivedWorkspaceIds: string[] = [];

  const results = await Promise.allSettled(
    targetWorkspaceIds.map(async (workspaceId) => {
      const contents = await archiveWorkspaceContents(
        dependencies,
        workspaceId,
        options.archivedAt,
      );
      // Agents and terminals are down, the record is not: an abort here leaves the workspace
      // listed, and cancellation restores agents carrying this operation stamp.
      options.checkpoint();
      await dependencies.archiveWorkspaceRecord(workspaceId, options.archivedAt);
      return { workspaceId, agents: contents };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      archivedWorkspaceIds.push(result.value.workspaceId);
      for (const agentId of result.value.agents) {
        archivedAgents.add(agentId);
      }
    } else if (result.reason instanceof WorkspaceArchiveCanceledError) {
      throw result.reason;
    } else {
      dependencies.sessionLogger?.warn(
        { err: result.reason, requestId: options.requestId },
        "archiveByScope workspace teardown failed; continuing",
      );
    }
  }

  return { archivedAgents, archivedWorkspaceIds };
}

async function maybeRemoveDirectory(
  dependencies: ArchiveDependencies,
  request: { requestId: string; checkpoint: () => void },
  target: ArchiveTarget,
  archivedWorkspaceIds: string[],
): Promise<{
  removedDirectory: boolean;
  directoryLeftBehind?: { path: string; reason: string };
}> {
  const backing = target.backing;
  if (!backing?.isPaseoOwnedWorktree) {
    // Missing ownership proof for a worktree-backed directory: the record
    // still archives, but the directory is left in place and surfaced.
    // Never delete an unproven directory.
    if (backing?.expectsPaseoOwnership) {
      const reason =
        "no ownership proof (not under the Paseo worktrees root, no paseo/worktree.json marker, no registry record)";
      dependencies.sessionLogger?.warn(
        { targetPath: backing.path, requestId: request.requestId },
        `Worktree directory left in place during archive: ${reason}`,
      );
      return {
        removedDirectory: false,
        directoryLeftBehind: { path: backing.path, reason },
      };
    }
    return { removedDirectory: false };
  }

  const archivedWorkspaceIdSet = new Set(archivedWorkspaceIds);
  const teardownTargets = target.teardownTargets.filter((teardownTarget) =>
    archivedWorkspaceIdSet.has(teardownTarget.workspaceId),
  );

  const teardownPlan = await resolveCheckoutTeardownPlan(
    dependencies,
    backing,
    teardownTargets,
    target.checkoutWorkspaceIds,
  );
  let untrustedBacking =
    teardownPlan.untrustedBacking || Boolean(await dependencies.isCheckoutUntrusted(backing.path));
  try {
    for (const teardownTarget of uniqueTeardownTargets(teardownPlan.allowedTargets)) {
      request.checkpoint();
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
      return { removedDirectory: false };
    }
    throw error;
  }

  const remainingActive = await dependencies.listActiveWorkspaces();
  if (
    !(await isDirectoryUnreferenced(
      remainingActive,
      backing,
      new Set(archivedWorkspaceIds),
      dependencies,
    ))
  ) {
    return { removedDirectory: false };
  }

  // Last chance to keep the directory. Teardown commands already ran, so a cancel here restores
  // a workspace whose teardown hooks fired; that beats deleting what the user asked to keep.
  request.checkpoint();
  try {
    await deletePaseoWorktree({
      cwd: backing.mainRepoRoot,
      worktreePath: backing.path,
      teardownCwds: [],
      worktreesRoot: backing.paseoWorktreesRoot ?? undefined,
      paseoHome: dependencies.paseoHome,
      worktreesBaseRoot: dependencies.paseoWorktreesBaseRoot,
      registryProven: backing.registryProven,
      worktreeManagers: dependencies.worktreeManagers,
      worktreeManagerPluginId: backing.worktreeManagerPluginId,
      removeReason: "archive",
      untrusted: untrustedBacking,
    });
    dependencies.workspaceGitService.invalidateWorktrees();
    dependencies.github.invalidate({ cwd: backing.path });
    return { removedDirectory: true };
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, targetPath: backing.path, requestId: request.requestId },
      "Worktree disk removal failed during archive; workspace already archived",
    );
    return { removedDirectory: false };
  }
}

async function resolveCheckoutTeardownPlan(
  dependencies: ArchiveDependencies,
  backing: BackingDirectory,
  teardownTargets: Array<{ workspaceId: string; cwd: string }>,
  checkoutWorkspaceIds: string[],
): Promise<{
  allowedTargets: Array<{ workspaceId: string; cwd: string }>;
  untrustedBacking: boolean;
}> {
  const metadataUntrustedSource =
    (await readPaseoWorktreeMetadata(backing.path).catch(() => null))?.untrustedSource ?? null;
  const checkoutUntrusted = Boolean(backing.untrustedSource || metadataUntrustedSource);
  const teardownGate = checkoutUntrusted
    ? { allowed: [] as Array<{ workspaceId: string; cwd: string }>, blockedSource: null }
    : await filterAllowedTeardownTargets(dependencies, teardownTargets, checkoutWorkspaceIds);
  const untrustedSourceToPersist =
    teardownTargets.length === 0 || metadataUntrustedSource
      ? null
      : (backing.untrustedSource ?? teardownGate.blockedSource);
  if (untrustedSourceToPersist) {
    // Runs inside workspaceArchiveOperations.withCheckout alongside Run setup approval,
    // so retained pre-upgrade checkouts keep their block without racing approval clears.
    await setPaseoWorktreeUntrustedSource(backing.path, untrustedSourceToPersist).catch(
      () => false,
    );
  }
  return {
    allowedTargets: teardownGate.allowed,
    untrustedBacking: checkoutUntrusted || teardownGate.allowed.length < teardownTargets.length,
  };
}

async function filterAllowedTeardownTargets(
  dependencies: ArchiveDependencies,
  targets: Array<{ workspaceId: string; cwd: string }>,
  checkoutWorkspaceIds: string[],
): Promise<{
  allowed: Array<{ workspaceId: string; cwd: string }>;
  blockedSource: UntrustedWorkspaceSource | null;
}> {
  if (targets.length === 0) {
    return { allowed: [], blockedSource: null };
  }
  if (typeof dependencies.assertWorkspaceAutomationAllowed !== "function") {
    return { allowed: [], blockedSource: null };
  }
  const workspaceIdsToCheck = Array.from(
    new Set([...targets.map((target) => target.workspaceId), ...checkoutWorkspaceIds]),
  );
  for (const workspaceId of workspaceIdsToCheck) {
    try {
      await dependencies.assertWorkspaceAutomationAllowed(workspaceId);
    } catch (error) {
      if (!(error instanceof WorkspaceAutomationBlockedError)) throw error;
      // Every workspace in checkoutWorkspaceIds shares the same backing checkout;
      // if any active workspace on it is blocked, skip teardown for the checkout.
      return { allowed: [], blockedSource: error.source };
    }
  }
  return { allowed: targets, blockedSource: null };
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
  archivedAt = new Date().toISOString(),
): Promise<Set<string>> {
  const archivedAgents = new Set<string>();

  const liveAgents = dependencies.agentManager
    .listAgents({ includeInternal: true })
    .filter((agent) => agent.workspaceId === workspaceId);
  for (const agent of liveAgents) {
    archivedAgents.add(agent.id);
  }

  let storedRecords: StoredAgentRecord[] = [];
  try {
    storedRecords = await dependencies.agentStorage.listByWorkspace(workspaceId);
  } catch (error) {
    dependencies.sessionLogger?.warn(
      { err: error, workspaceId },
      "Failed to list stored agents during workspace archive; continuing",
    );
  }
  const matchingStoredRecords = storedRecords;
  for (const record of matchingStoredRecords) {
    archivedAgents.add(record.id);
  }

  const agentIdsToArchive = [
    ...new Set([
      ...liveAgents.map((agent) => agent.id),
      ...matchingStoredRecords.filter((record) => !record.archivedAt).map((record) => record.id),
    ]),
  ];
  const [agentResults, [terminalResult]] = await Promise.all([
    Promise.allSettled(
      agentIdsToArchive.map((agentId) =>
        dependencies.agentManager.getAgent(agentId)
          ? dependencies.agentManager.archiveAgent(agentId, archivedAt)
          : dependencies.agentManager.archiveSnapshot(agentId, archivedAt),
      ),
    ),
    Promise.allSettled([dependencies.killTerminalsForWorkspace(workspaceId)]),
  ]);

  for (const [index, result] of agentResults.entries()) {
    const agentId = agentIdsToArchive[index]!;
    if (result.status === "rejected") {
      dependencies.sessionLogger?.warn(
        { err: result.reason, workspaceId, agentId },
        "Workspace archive teardown step failed; continuing",
      );
    }
  }
  if (terminalResult?.status === "rejected") {
    dependencies.sessionLogger?.warn(
      { err: terminalResult.reason, workspaceId },
      "Workspace archive teardown step failed; continuing",
    );
  }

  return archivedAgents;
}

// Active workspaces on the same checkout keep it alive. A manager can place
// a checkout anywhere, so also protect nested workspaces when either checkout
// is manager-owned.
async function isDirectoryUnreferenced(
  activeWorkspaces: ActiveWorkspaceRef[],
  targetDirectory: BackingDirectory,
  archivedWorkspaceIds: ReadonlySet<string>,
  dependencies: Pick<ArchiveDependencies, "paseoHome" | "paseoWorktreesBaseRoot">,
): Promise<boolean> {
  const target = targetDirectory.path;
  const matchesTarget = createRealpathAwarePathMatcher(target);
  for (const workspace of activeWorkspaces) {
    if (archivedWorkspaceIds.has(workspace.workspaceId)) continue;
    const backingDirectory = await resolveWorkspaceBackingDirectory(workspace, dependencies);
    if (matchesTarget(backingDirectory.path)) return false;
    if (
      (targetDirectory.worktreeManagerPluginId || backingDirectory.worktreeManagerPluginId) &&
      (isRealpathInsideRoot(target, backingDirectory.path) ||
        isRealpathInsideRoot(target, workspace.cwd))
    ) {
      return false;
    }
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
  let head: string | null = null;
  if (existingWorkspace.kind === "worktree") {
    const cwd = existingWorkspace.worktreeRoot ?? existingWorkspace.cwd;
    head = await readWorktreeHeadReference(cwd);
  }
  await input.workspaceRegistry.archive(input.workspaceId, archivedAt, {
    ...input.context,
    ...(head ? { head } : {}),
  });

  return existingWorkspace;
}

export interface WorkspaceArchiveRestoreRequest {
  workspaceId: string;
  archivedAt: string;
  allowLegacyFallback?: boolean;
}

interface UnarchiveWorkspaceAgentsInput extends WorkspaceArchiveRestoreRequest {
  agentStorage: Pick<AgentStorage, "listByWorkspace">;
  unarchiveAgent: (agentId: string) => Promise<unknown>;
  sessionLogger?: Logger;
}

export async function unarchiveWorkspaceAgents(
  input: UnarchiveWorkspaceAgentsInput,
): Promise<void> {
  const { workspaceId, archivedAt, allowLegacyFallback = true } = input;
  const records = await input.agentStorage.listByWorkspace(workspaceId);
  const exact = records.filter((record) => record.archivedAt === archivedAt);
  // COMPAT(workspaceArchiveStamp): added in v0.15.3; remove after 2027-05-09 once old workspace archives no longer need restoration.
  const matching =
    exact.length > 0 || !allowLegacyFallback
      ? exact
      : records.filter((record) => {
          if (!record.archivedAt) return false;
          const age = Date.parse(archivedAt) - Date.parse(record.archivedAt);
          return age >= 0 && age <= 60_000;
        });
  const results = await Promise.allSettled(
    matching.map((record) => input.unarchiveAgent(record.id)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      input.sessionLogger?.warn(
        { err: result.reason, workspaceId, agentId: matching[index]!.id },
        "Failed to unarchive workspace agent",
      );
    }
  }
}
