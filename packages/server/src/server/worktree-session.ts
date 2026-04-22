import type { Logger } from "pino";
import { basename } from "node:path";

import type { AgentSessionConfig } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import {
  type AgentAttachment,
  type GitSetupOptions,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { normalizeWorkspaceId as normalizePersistedWorkspaceId } from "./workspace-registry-model.js";
import {
  applyWorktreeSetupProgressEvent,
  buildWorktreeSetupDetail,
  createWorktreeSetupProgressAccumulator,
  getWorktreeSetupProgressResults,
} from "./worktree-bootstrap.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { ScriptRouteStore } from "./script-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { GitHubService } from "../services/github-service.js";
import type { CheckoutExistingBranchResult } from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import {
  deletePaseoWorktree,
  getWorktreeSetupCommands,
  isPaseoOwnedWorktreeCwd,
  resolvePaseoWorktreeRootForCwd,
  resolveWorktreeRuntimeEnv,
  runWorktreeSetupCommands,
  slugify,
  validateBranchSlug,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
  WorktreeSetupError,
} from "../utils/worktree.js";
import { toCheckoutError } from "./checkout-git-utils.js";
import type {
  CreatePaseoWorktreeInput,
  CreatePaseoWorktreeResult,
} from "./paseo-worktree-service.js";
import { toWorktreeWireError } from "./worktree-errors.js";

const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;

export interface NormalizedGitOptions {
  baseBranch?: string;
  createNewBranch: boolean;
  newBranchName?: string;
  createWorktree: boolean;
  worktreeSlug?: string;
  requestedWorktreeSlug?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  githubPrNumber?: number;
}

type EmitSessionMessage = (message: SessionOutboundMessage) => void;

type BuildAgentSessionConfigDependencies = {
  paseoHome?: string;
  sessionLogger: Logger;
  workspaceGitService?: WorkspaceGitService;
  createPaseoWorktree: (
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ) => Promise<CreatePaseoWorktreeResult>;
  checkoutExistingBranch: (cwd: string, branch: string) => Promise<CheckoutExistingBranchResult>;
  createBranchFromBase: (params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }) => Promise<void>;
  github?: Pick<GitHubService, "invalidate">;
};

type ArchivePaseoWorktreeDependencies = {
  paseoHome?: string;
  github: GitHubService;
  workspaceGitService: WorkspaceGitService;
  agentManager: Pick<AgentManager, "listAgents" | "closeAgent">;
  agentStorage: Pick<AgentStorage, "list" | "remove">;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emit: EmitSessionMessage;
  emitWorkspaceUpdatesForCwds: (cwds: Iterable<string>) => Promise<void>;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTerminalsUnderPath: (rootPath: string) => Promise<void>;
  sessionLogger?: Logger;
};

type CreatePaseoWorktreeInBackgroundDependencies = {
  paseoHome?: string;
  emitWorkspaceUpdateForCwd: (cwd: string, options?: { dedupeGitState?: boolean }) => Promise<void>;
  cacheWorkspaceSetupSnapshot: (workspaceId: string, snapshot: WorkspaceSetupSnapshot) => void;
  emit: EmitSessionMessage;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  scriptRouteStore: ScriptRouteStore | null;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  getDaemonTcpPort: (() => number | null) | null;
  getDaemonTcpHost: (() => string | null) | null;
  onScriptsChanged: ((workspaceId: string, workspaceDirectory: string) => void) | null;
};

type HandleWorkspaceSetupStatusRequestDependencies = {
  emit: EmitSessionMessage;
  workspaceSetupSnapshots: ReadonlyMap<string, WorkspaceSetupSnapshot>;
};

type HandleCreatePaseoWorktreeRequestDependencies = {
  paseoHome?: string;
  describeWorkspaceRecord: (
    result: CreatePaseoWorktreeResult,
  ) => Promise<WorkspaceDescriptorPayload>;
  emit: EmitSessionMessage;
  createPaseoWorktree: (input: CreatePaseoWorktreeInput) => Promise<CreatePaseoWorktreeResult>;
  warmWorkspaceGitData: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  sessionLogger: Logger;
  runWorktreeSetupInBackground: (options: {
    requestCwd: string;
    repoRoot: string;
    workspaceId: string;
    worktree: WorktreeConfig;
    shouldBootstrap: boolean;
    slug: string;
    worktreePath: string;
  }) => Promise<void>;
};

type KillTerminalsUnderPathDependencies = {
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTrackedTerminal: (terminalId: string, options?: { emitExit: boolean }) => void;
  detachTerminalStream?: (terminalId: string, options: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
};

export async function buildAgentSessionConfig(
  dependencies: BuildAgentSessionConfigDependencies,
  config: AgentSessionConfig,
  gitOptions?: GitSetupOptions,
  legacyWorktreeName?: string,
  attachments?: AgentAttachment[],
): Promise<{
  sessionConfig: AgentSessionConfig;
  worktreeBootstrap?: { worktree: WorktreeConfig; shouldBootstrap: boolean };
}> {
  let cwd = expandTilde(config.cwd);
  const normalized = normalizeGitOptions(gitOptions, legacyWorktreeName);
  let worktreeBootstrap: { worktree: WorktreeConfig; shouldBootstrap: boolean } | undefined;

  if (!normalized) {
    return {
      sessionConfig: {
        ...config,
        cwd,
      },
    };
  }

  if (normalized.createWorktree) {
    dependencies.sessionLogger.info(
      { worktreeSlug: normalized.requestedWorktreeSlug },
      "Creating worktree through createWorktreeCore",
    );

    const createdWorktree = await dependencies.createPaseoWorktree(
      {
        cwd,
        worktreeSlug: normalized.worktreeSlug,
        refName: normalized.refName,
        action: normalized.action,
        githubPrNumber: normalized.githubPrNumber,
        attachments,
        runSetup: false,
        paseoHome: dependencies.paseoHome,
      },
      {
        resolveDefaultBranch: normalized.baseBranch
          ? async () => normalized.baseBranch!
          : (repoRoot) =>
              resolveGitCreateBaseBranch(
                repoRoot,
                dependencies.workspaceGitService,
                dependencies.paseoHome,
              ),
      },
    );
    cwd = createdWorktree.worktree.worktreePath;
    worktreeBootstrap = {
      worktree: createdWorktree.worktree,
      shouldBootstrap: createdWorktree.created,
    };
  } else if (normalized.createNewBranch) {
    const baseBranch =
      normalized.baseBranch ??
      (await resolveGitCreateBaseBranch(
        cwd,
        dependencies.workspaceGitService,
        dependencies.paseoHome,
      ));
    await dependencies.createBranchFromBase({
      cwd,
      baseBranch,
      newBranchName: normalized.newBranchName!,
    });
    dependencies.github?.invalidate({ cwd });
  } else if (normalized.baseBranch) {
    await dependencies.checkoutExistingBranch(cwd, normalized.baseBranch);
    dependencies.github?.invalidate({ cwd });
  }

  return {
    sessionConfig: {
      ...config,
      cwd,
    },
    worktreeBootstrap,
  };
}

export function normalizeGitOptions(
  gitOptions?: GitSetupOptions,
  legacyWorktreeName?: string,
): NormalizedGitOptions | null {
  const fallbackOptions: GitSetupOptions | undefined = legacyWorktreeName
    ? {
        createWorktree: true,
        createNewBranch: true,
        newBranchName: legacyWorktreeName,
        worktreeSlug: legacyWorktreeName,
      }
    : undefined;

  const merged = gitOptions ?? fallbackOptions;
  if (!merged) {
    return null;
  }

  const baseBranch = merged.baseBranch?.trim() || undefined;
  const createWorktree = Boolean(merged.createWorktree);
  const createNewBranch = Boolean(merged.createNewBranch);
  const normalizedBranchName = merged.newBranchName ? slugify(merged.newBranchName) : undefined;
  const requestedWorktreeSlug = merged.worktreeSlug ? slugify(merged.worktreeSlug) : undefined;
  const normalizedWorktreeSlug = requestedWorktreeSlug ?? normalizedBranchName;
  const refName = merged.refName?.trim() || undefined;
  const action = merged.action;
  const githubPrNumber = merged.githubPrNumber;

  if (
    !createWorktree &&
    !createNewBranch &&
    !baseBranch &&
    !refName &&
    !action &&
    !githubPrNumber
  ) {
    return null;
  }

  if (baseBranch) {
    assertSafeGitRef(baseBranch, "base branch");
  }

  if (createNewBranch) {
    if (!normalizedBranchName) {
      throw new Error("New branch name is required");
    }
    const validation = validateBranchSlug(normalizedBranchName);
    if (!validation.valid) {
      throw new Error(`Invalid branch name: ${validation.error}`);
    }
  }

  if (normalizedWorktreeSlug) {
    const validation = validateBranchSlug(normalizedWorktreeSlug);
    if (!validation.valid) {
      throw new Error(`Invalid worktree name: ${validation.error}`);
    }
  }

  return {
    baseBranch,
    createNewBranch,
    newBranchName: normalizedBranchName,
    createWorktree,
    worktreeSlug: normalizedWorktreeSlug,
    requestedWorktreeSlug,
    refName,
    action,
    githubPrNumber,
  };
}

export function assertSafeGitRef(ref: string, label: string): void {
  if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.includes("..") || ref.includes("@{")) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
}

export async function resolveGitCreateBaseBranch(
  cwd: string,
  workspaceGitService?: WorkspaceGitService,
  _paseoHome?: string,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("WorkspaceGitService is required to resolve the repository root");
  }

  return workspaceGitService.resolveDefaultBranch(cwd);
}

export async function handlePaseoWorktreeListRequest(
  dependencies: {
    emit: EmitSessionMessage;
    paseoHome?: string;
    workspaceGitService: WorkspaceGitService;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>,
): Promise<void> {
  const { requestId } = msg;
  const cwd = msg.repoRoot ?? msg.cwd;
  if (!cwd) {
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
        requestId,
      },
    });
    return;
  }

  try {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(cwd);
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: worktrees.map((entry) => ({
          worktreePath: entry.path,
          createdAt: entry.createdAt,
          branchName: entry.branchName ?? null,
          head: entry.head ?? null,
        })),
        error: null,
        requestId,
      },
    });
  } catch (error) {
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: toCheckoutError(error),
        requestId,
      },
    });
  }
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

  // Fan out agent close + terminal teardown concurrently. We never let a
  // per-item failure abort the archive — the FS delete must still run so the
  // worktree doesn't get stuck half-dead.
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

  // Agent storage removal runs after closeAgent so file handles on the agent
  // state file are released; still allSettled so a single bad record can't
  // derail the rest.
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

  for (const workspaceId of affectedWorkspaceIds) {
    try {
      await dependencies.archiveWorkspaceRecord(workspaceId);
    } catch (error) {
      dependencies.sessionLogger?.warn(
        { err: error, workspaceId },
        "Failed to archive workspace record; worktree FS already removed",
      );
    }
  }

  for (const agentId of removedAgents) {
    dependencies.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId: options.requestId,
      },
    });
  }

  await dependencies.emitWorkspaceUpdatesForCwds(affectedWorkspaceCwds);

  return Array.from(removedAgents);
}

export async function handlePaseoWorktreeArchiveRequest(
  dependencies: Omit<ArchivePaseoWorktreeDependencies, "emitWorkspaceUpdatesForCwds"> & {
    emit: EmitSessionMessage;
    emitWorkspaceUpdatesForCwds: (cwds: Iterable<string>) => Promise<void>;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
): Promise<void> {
  const { requestId } = msg;
  let targetPath = msg.worktreePath;
  let repoRoot = msg.repoRoot ?? null;

  try {
    if (!targetPath) {
      if (!repoRoot || !msg.branchName) {
        throw new Error("worktreePath or repoRoot+branchName is required");
      }
      const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
      const match = worktrees.find((entry) => entry.branchName === msg.branchName);
      if (!match) {
        throw new Error(`Paseo worktree not found for branch ${msg.branchName}`);
      }
      targetPath = match.path;
    }

    const ownership = await isPaseoOwnedWorktreeCwd(targetPath, {
      paseoHome: dependencies.paseoHome,
    });
    if (!ownership.allowed) {
      dependencies.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          removedAgents: [],
          error: {
            code: "NOT_ALLOWED",
            message: "Worktree is not a Paseo-owned worktree",
          },
          requestId,
        },
      });
      return;
    }

    // repoRoot is best-effort: if git has forgotten about the worktree we
    // still proceed using the path-derived worktreesRoot, since the ownership
    // check already proved the path lives under $PASEO_HOME/worktrees.
    repoRoot = ownership.repoRoot ?? repoRoot ?? null;

    const removedAgents = await archivePaseoWorktree(dependencies, {
      targetPath,
      repoRoot,
      worktreesRoot: ownership.worktreeRoot,
      requestId,
    });

    dependencies.emit({
      type: "paseo_worktree_archive_response",
      payload: {
        success: true,
        removedAgents,
        error: null,
        requestId,
      },
    });
  } catch (error) {
    dependencies.emit({
      type: "paseo_worktree_archive_response",
      payload: {
        success: false,
        removedAgents: [],
        error: toCheckoutError(error),
        requestId,
      },
    });
  }
}

export async function handleCreatePaseoWorktreeRequest(
  dependencies: HandleCreatePaseoWorktreeRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
): Promise<void> {
  try {
    const createdWorktree = await dependencies.createPaseoWorktree({
      cwd: request.cwd,
      worktreeSlug: request.worktreeSlug,
      refName: request.refName,
      action: request.action,
      githubPrNumber: request.githubPrNumber,
      attachments: request.attachments,
      runSetup: false,
      paseoHome: dependencies.paseoHome,
    });
    const slug = basename(createdWorktree.worktree.worktreePath);
    const workspace = createdWorktree.workspace;

    const descriptor = await dependencies.describeWorkspaceRecord(createdWorktree);
    dependencies.emit({
      type: "create_paseo_worktree_response",
      payload: {
        workspace: descriptor,
        error: null,
        setupTerminalId: null,
        requestId: request.requestId,
      },
    });
    dependencies.emit({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: descriptor,
      },
    });

    void dependencies.warmWorkspaceGitData(workspace).catch((error) => {
      dependencies.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm workspace git data after creating worktree",
      );
    });
    void dependencies.runWorktreeSetupInBackground({
      requestCwd: request.cwd,
      repoRoot: createdWorktree.repoRoot,
      workspaceId: workspace.workspaceId,
      worktree: createdWorktree.worktree,
      shouldBootstrap: createdWorktree.created,
      slug,
      worktreePath: createdWorktree.worktree.worktreePath,
    });
  } catch (error) {
    const wireError = toWorktreeWireError(error);
    dependencies.sessionLogger.error(
      { err: error, cwd: request.cwd, worktreeSlug: request.worktreeSlug },
      "Failed to create worktree",
    );
    dependencies.emit({
      type: "create_paseo_worktree_response",
      payload: {
        workspace: null,
        error: wireError.message,
        errorCode: wireError.code,
        setupTerminalId: null,
        requestId: request.requestId,
      },
    });
  }
}

export async function handleWorkspaceSetupStatusRequest(
  dependencies: HandleWorkspaceSetupStatusRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
): Promise<void> {
  const workspaceId = request.workspaceId;
  const snapshot = dependencies.workspaceSetupSnapshots.get(workspaceId) ?? null;

  dependencies.emit({
    type: "workspace_setup_status_response",
    payload: {
      requestId: request.requestId,
      workspaceId,
      snapshot,
    },
  });
}

export async function runWorktreeSetupInBackground(
  dependencies: CreatePaseoWorktreeInBackgroundDependencies,
  options: {
    requestCwd: string;
    repoRoot: string;
    workspaceId: string;
    worktree: WorktreeConfig;
    shouldBootstrap: boolean;
    slug: string;
    worktreePath: string;
  },
): Promise<void> {
  let worktree: WorktreeConfig = options.worktree;
  let setupResults: WorktreeSetupCommandResult[] = [];
  let setupStarted = false;
  const progressAccumulator = createWorktreeSetupProgressAccumulator();
  const workspaceId = String(options.workspaceId);

  const emitSetupProgress = (status: "running" | "completed" | "failed", error: string | null) => {
    const snapshot: WorkspaceSetupSnapshot = {
      status,
      detail: buildWorktreeSetupDetail({
        worktree,
        results:
          status === "running"
            ? getWorktreeSetupProgressResults(progressAccumulator)
            : setupResults,
        outputAccumulatorsByIndex: progressAccumulator.outputAccumulatorsByIndex,
      }),
      error,
    };
    dependencies.cacheWorkspaceSetupSnapshot(workspaceId, snapshot);
    dependencies.emit({
      type: "workspace_setup_progress",
      payload: {
        workspaceId,
        ...snapshot,
      },
    });
  };

  try {
    try {
      emitSetupProgress("running", null);

      if (!options.shouldBootstrap) {
        emitSetupProgress("completed", null);
      } else {
        const setupCommands = getWorktreeSetupCommands(worktree.worktreePath);
        if (setupCommands.length === 0) {
          setupStarted = true;
          emitSetupProgress("completed", null);
        } else {
          const runtimeEnv = await resolveWorktreeRuntimeEnv({
            worktreePath: worktree.worktreePath,
            branchName: worktree.branchName,
            repoRootPath: options.repoRoot,
          });
          dependencies.terminalManager?.registerCwdEnv({
            cwd: worktree.worktreePath,
            env: runtimeEnv,
          });
          setupStarted = true;
          setupResults = await runWorktreeSetupCommands({
            worktreePath: worktree.worktreePath,
            branchName: worktree.branchName,
            cleanupOnFailure: false,
            repoRootPath: options.repoRoot,
            runtimeEnv,
            onEvent: (event) => {
              applyWorktreeSetupProgressEvent(progressAccumulator, event);
              emitSetupProgress("running", null);
            },
          });
          emitSetupProgress("completed", null);
        }
      }
    } catch (error) {
      if (error instanceof WorktreeSetupError) {
        setupResults = error.results;
      }
      const message = error instanceof Error ? error.message : String(error);
      emitSetupProgress("failed", message);

      if (!setupStarted) {
        await dependencies.archiveWorkspaceRecord(options.workspaceId);
      }

      dependencies.sessionLogger.error(
        {
          err: error,
          cwd: options.requestCwd,
          repoRoot: options.repoRoot,
          worktreeSlug: worktree.branchName,
          worktreePath: worktree.worktreePath,
          setupStarted,
        },
        "Background worktree setup failed",
      );
      return;
    }
  } finally {
    await dependencies.emitWorkspaceUpdateForCwd(worktree.worktreePath);
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
  const terminalDirectories = [...terminalManager.listDirectories()];
  for (const terminalCwd of terminalDirectories) {
    if (!dependencies.isPathWithinRoot(rootPath, terminalCwd)) {
      continue;
    }
    try {
      const terminals = await terminalManager.getTerminals(terminalCwd);
      for (const terminal of terminals) {
        terminalIds.push(terminal.id);
      }
    } catch (error) {
      dependencies.sessionLogger.warn(
        { err: error, cwd: terminalCwd },
        "Failed to enumerate worktree terminals during archive",
      );
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
