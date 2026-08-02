import type { Logger } from "pino";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import type { AgentSessionConfig } from "./agent/agent-sdk-types.js";
import {
  type GitSetupOptions,
  type FirstAgentContext,
  type ChangeRequestCheckoutSource,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  runAsyncWorktreeBootstrap,
  applyWorktreeSetupProgressEvent,
  buildWorktreeSetupDetail,
  createWorktreeSetupProgressAccumulator,
  getWorktreeSetupProgressResults,
} from "./worktree-bootstrap.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { CheckoutExistingBranchResult } from "../utils/checkout-git.js";
import { createRealpathAwarePathMatcher, expandTilde } from "../utils/path.js";
import {
  getWorktreeSetupCommands,
  isPaseoOwnedWorktreeCwd,
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
import type { ArchiveDependencies } from "./workspace-archive-service.js";
import { toWorktreeWireError } from "./worktree-errors.js";
import {
  archiveCommand,
  createPaseoWorktreeCommand,
  listPaseoWorktreesCommand,
} from "./worktree/commands.js";
import {
  assertNonEmptyWorktreeRepositorySelectors,
  canonicalizeExistingRoot,
  resolveWorktreeRepositoryIdentity,
} from "./worktree-repository-identity.js";

const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface NormalizedGitOptions {
  baseBranch?: string;
  createNewBranch: boolean;
  newBranchName?: string;
  createWorktree: boolean;
  worktreeSlug?: string;
  requestedWorktreeSlug?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
}

type EmitSessionMessage = (message: SessionOutboundMessage) => void;
type AgentWorktreeSetupTimelineItem = Parameters<
  typeof runAsyncWorktreeBootstrap
>[0]["appendTimelineItem"] extends (item: infer Item) => unknown
  ? Item
  : never;
type AgentWorktreeSetupTimelineWriter = (input: {
  agentId: string;
  item: AgentWorktreeSetupTimelineItem;
}) => Promise<boolean>;

interface BuildAgentSessionConfigDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  sessionLogger: Logger;
  workspaceGitService?: WorkspaceGitService;
  createPaseoWorktree: (
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
      setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
    },
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  checkoutExistingBranch: (cwd: string, branch: string) => Promise<CheckoutExistingBranchResult>;
  createBranchFromBase: (params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }) => Promise<void>;
}

interface CreatePaseoWorktreeInBackgroundDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  cacheWorkspaceSetupSnapshot: (workspaceId: string, snapshot: WorkspaceSetupSnapshot) => void;
  emit: EmitSessionMessage;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  serviceProxy: ServiceProxySubsystem | null;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  getDaemonTcpPort: (() => number | null) | null;
  getDaemonTcpHost: (() => string | null) | null;
  serviceProxyPublicBaseUrl?: string | null;
  onScriptsChanged: ((workspaceId: string, workspaceDirectory: string) => void) | null;
}

interface CreatePaseoWorktreeWorkflowDependencies extends CreatePaseoWorktreeInBackgroundDependencies {
  createPaseoWorktree: (
    input: CreatePaseoWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ) => Promise<CreatePaseoWorktreeResult>;
  warmWorkspaceGitData: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  autoNameWorkspaceBranchForFirstAgent: (input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
  }) => void;
}

interface AgentWorktreeSetupContinuationInput {
  kind: "agent";
  terminalManager: TerminalManager | null;
  appendTimelineItem: AgentWorktreeSetupTimelineWriter;
  emitLiveTimelineItem: AgentWorktreeSetupTimelineWriter;
  logger: Logger;
}

export type CreatePaseoWorktreeSetupContinuationInput =
  | { kind: "workspace" }
  | AgentWorktreeSetupContinuationInput;

export interface AgentWorktreeSetupContinuation {
  kind: "agent";
  startAfterAgentCreate: (input: { agentId: string }) => void;
}

export type CreatePaseoWorktreeWorkflowResult = CreatePaseoWorktreeResult & {
  setupContinuation?: AgentWorktreeSetupContinuation;
};

export type CreatePaseoWorktreeWorkflowFn = (
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
  },
) => Promise<CreatePaseoWorktreeWorkflowResult>;

interface HandleWorkspaceSetupStatusRequestDependencies {
  emit: EmitSessionMessage;
  workspaceSetupSnapshots: ReadonlyMap<string, WorkspaceSetupSnapshot>;
}

interface HandleCreatePaseoWorktreeRequestDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  describeWorkspaceRecord: (
    result: CreatePaseoWorktreeResult,
  ) => Promise<WorkspaceDescriptorPayload>;
  emit: EmitSessionMessage;
  sessionLogger: Logger;
  projectRegistry: Pick<ProjectRegistry, "get" | "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
  createPaseoWorktreeWorkflow: (
    input: CreatePaseoWorktreeInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
}

function normalizeFirstAgentContext(
  request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
): FirstAgentContext | undefined {
  if (request.firstAgentContext) {
    return request.firstAgentContext;
  }

  if (request.attachments || request.nameContext) {
    return {
      attachments: request.attachments ?? [],
      ...(request.nameContext ? { prompt: request.nameContext } : {}),
    };
  }

  return undefined;
}

export async function buildAgentSessionConfig(
  dependencies: BuildAgentSessionConfigDependencies,
  config: AgentSessionConfig,
  gitOptions?: GitSetupOptions,
  legacyWorktreeName?: string,
  firstAgentContext?: FirstAgentContext,
): Promise<{
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
  createdWorkspaceId?: string;
}> {
  let cwd = expandTilde(config.cwd);
  const normalized = normalizeGitOptions(gitOptions, legacyWorktreeName);
  let setupContinuation: AgentWorktreeSetupContinuation | undefined;
  let createdWorkspaceId: string | undefined;

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
        checkoutSource: normalized.checkoutSource,
        githubPrNumber: normalized.githubPrNumber,
        firstAgentContext,
        runSetup: false,
        paseoHome: dependencies.paseoHome,
        worktreesRoot: dependencies.worktreesRoot,
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
    cwd = createdWorktree.workspace.cwd;
    setupContinuation = createdWorktree.setupContinuation;
    createdWorkspaceId = createdWorktree.workspace.workspaceId;
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
    dependencies.workspaceGitService?.invalidateForge(cwd);
  } else if (normalized.baseBranch) {
    await dependencies.checkoutExistingBranch(cwd, normalized.baseBranch);
    dependencies.workspaceGitService?.invalidateForge(cwd);
  }

  return {
    sessionConfig: {
      ...config,
      cwd,
    },
    setupContinuation,
    createdWorkspaceId,
  };
}

interface ValidateNormalizedGitOptionsInput {
  baseBranch: string | undefined;
  createNewBranch: boolean;
  normalizedBranchName: string | undefined;
  normalizedWorktreeSlug: string | undefined;
}

function validateNormalizedGitOptions(input: ValidateNormalizedGitOptionsInput): void {
  if (input.baseBranch) {
    assertSafeGitRef(input.baseBranch, "base branch");
  }

  if (input.createNewBranch) {
    if (!input.normalizedBranchName) {
      throw new Error("New branch name is required");
    }
    const validation = validateBranchSlug(input.normalizedBranchName);
    if (!validation.valid) {
      throw new Error(`Invalid branch name: ${validation.error}`);
    }
  }

  if (input.normalizedWorktreeSlug) {
    const validation = validateBranchSlug(input.normalizedWorktreeSlug);
    if (!validation.valid) {
      throw new Error(`Invalid worktree name: ${validation.error}`);
    }
  }
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
  // COMPAT(githubPrNumber): added in v0.1.106, remove after 2026-12-28 once
  // clients send checkoutSource.
  const checkoutSource =
    merged.checkoutSource ??
    (merged.githubPrNumber
      ? ({ kind: "change_request", forge: "github", number: merged.githubPrNumber } as const)
      : undefined);
  const githubPrNumber = merged.githubPrNumber;

  if (
    !createWorktree &&
    !createNewBranch &&
    !baseBranch &&
    !refName &&
    !action &&
    !checkoutSource &&
    !githubPrNumber
  ) {
    return null;
  }

  validateNormalizedGitOptions({
    baseBranch,
    createNewBranch,
    normalizedBranchName,
    normalizedWorktreeSlug,
  });

  return {
    baseBranch,
    createNewBranch,
    newBranchName: normalizedBranchName,
    createWorktree,
    worktreeSlug: normalizedWorktreeSlug,
    requestedWorktreeSlug,
    refName,
    action,
    checkoutSource,
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
    projectRegistry: Pick<ProjectRegistry, "get" | "list">;
    workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>,
): Promise<void> {
  const { requestId } = msg;
  let repository;
  try {
    repository = await resolveWorktreeRepositoryIdentity(msg, dependencies.projectRegistry, {
      workspaceRegistry: dependencies.workspaceRegistry,
      workspaceGitService: dependencies.workspaceGitService,
    });
  } catch (error) {
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) },
        requestId,
      },
    });
    return;
  }

  try {
    const worktrees = await listPaseoWorktreesCommand(
      { workspaceGitService: dependencies.workspaceGitService },
      { cwd: repository.repoRoot },
    );
    const listedWorktrees = worktrees.map((entry) => ({
      worktreePath: entry.path,
      createdAt: entry.createdAt,
      branchName: entry.branchName ?? null,
      head: entry.head ?? null,
    }));
    const pendingCleanupWorkspaces = (await dependencies.workspaceRegistry.list()).filter(
      (workspace) =>
        workspace.projectId === repository.projectId &&
        workspace.archivedAt !== null &&
        workspace.archiveCleanupPhase === "ready_to_delete" &&
        workspace.kind === "worktree" &&
        workspace.isPaseoOwnedWorktree &&
        workspace.worktreeRoot !== null &&
        existsSync(workspace.worktreeRoot),
    );
    for (const workspace of pendingCleanupWorkspaces) {
      if (
        listedWorktrees.some((worktree) =>
          createRealpathAwarePathMatcher(worktree.worktreePath)(workspace.worktreeRoot!),
        )
      ) {
        continue;
      }
      listedWorktrees.push({
        worktreePath: workspace.worktreeRoot!,
        createdAt: workspace.createdAt,
        branchName: workspace.branch,
        head: null,
      });
    }
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: listedWorktrees,
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

export async function handlePaseoWorktreeArchiveRequest(
  dependencies: Omit<
    ArchiveDependencies,
    "emitWorkspaceUpdatesForWorkspaceIds" | "workspaceGitService"
  > & {
    emit: EmitSessionMessage;
    workspaceGitService: Pick<
      WorkspaceGitService,
      "getSnapshot" | "invalidateWorktreeList" | "listWorktrees"
    >;
    projectRegistry: Pick<ProjectRegistry, "get" | "list">;
    workspaceRegistry: Pick<WorkspaceRegistry, "list">;
    emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
): Promise<void> {
  const { requestId } = msg;

  try {
    assertNonEmptyWorktreeRepositorySelectors(msg);
    const explicitWorkspacePlacement = msg.workspaceId
      ? await resolveExplicitWorkspaceArchivePlacement(msg, dependencies.workspaceRegistry)
      : null;
    const explicitlySelectedRepository =
      !msg.workspaceId && (msg.projectId || msg.repoRoot)
        ? await resolveWorktreeRepositoryIdentity(msg, dependencies.projectRegistry)
        : null;
    const archivedRetryPlacement = await resolveArchivedRetryPlacement({
      msg,
      workspaceRegistry: dependencies.workspaceRegistry,
      explicitWorkspacePlacement,
      selectedProjectId: explicitlySelectedRepository?.projectId,
    });
    const selectedPlacement = explicitWorkspacePlacement ?? archivedRetryPlacement;
    if (archivedRetryPlacement && !existsSync(archivedRetryPlacement.worktreePath)) {
      dependencies.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: true,
          removedAgents: [],
          error: null,
          requestId,
        },
      });
      return;
    }

    const repository = explicitWorkspacePlacement
      ? await resolveWorktreeRepositoryIdentity(
          {
            projectId: explicitWorkspacePlacement.projectId,
          },
          dependencies.projectRegistry,
        )
      : (explicitlySelectedRepository ??
        (await resolveWorktreeRepositoryIdentity(
          archivedRetryPlacement
            ? {
                projectId: archivedRetryPlacement.projectId,
                repoRoot: archivedRetryPlacement.mainRepoRoot ?? undefined,
              }
            : msg,
          dependencies.projectRegistry,
          {
            workspaceRegistry: dependencies.workspaceRegistry,
            workspaceGitService: dependencies.workspaceGitService,
          },
        )));
    const worktreePath =
      selectedPlacement?.worktreePath ??
      (await resolveRepositoryWorktreePath(
        dependencies.workspaceGitService,
        repository.repoRoot,
        msg.worktreePath,
        msg.branchName,
        {
          projectId: repository.projectId,
          workspaceRegistry: dependencies.workspaceRegistry,
          paseoHome: dependencies.paseoHome,
          worktreesRoot: dependencies.paseoWorktreesBaseRoot,
          branchName: msg.branchName,
        },
      ));
    const result = await archiveCommand(dependencies, {
      requestId,
      worktreePath,
      repoRoot: repository.repoRoot,
      branchName: msg.branchName,
      workspaceId: msg.workspaceId,
      scope: msg.scope,
      cleanup:
        archivedRetryPlacement?.archiveCleanupPhase === "ready_to_delete"
          ? {
              state: "ready_to_delete",
              workspaceIds: archivedRetryPlacement.workspaceIds,
            }
          : undefined,
    });
    if (!result.ok) {
      dependencies.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          removedAgents: result.removedAgents,
          error: {
            code: result.code,
            message: result.message,
          },
          requestId,
        },
      });
      return;
    }

    dependencies.emit({
      type: "paseo_worktree_archive_response",
      payload: {
        success: true,
        removedAgents: result.removedAgents,
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

interface PersistedArchiveRetryPlacement {
  projectId: string;
  worktreePath: string;
  mainRepoRoot: string | null;
  workspaceIds: string[];
  archiveCleanupPhase: "ready_to_delete" | null;
}

interface ExplicitWorkspaceArchivePlacement extends PersistedArchiveRetryPlacement {
  archivedAt: string | null;
}

interface ResolveArchivedRetryPlacementOptions {
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  explicitWorkspacePlacement: ExplicitWorkspaceArchivePlacement | null;
  selectedProjectId?: string;
}

async function resolveArchivedRetryPlacement({
  msg,
  workspaceRegistry,
  explicitWorkspacePlacement,
  selectedProjectId,
}: ResolveArchivedRetryPlacementOptions): Promise<PersistedArchiveRetryPlacement | null> {
  if (explicitWorkspacePlacement) {
    return explicitWorkspacePlacement.archivedAt !== null ? explicitWorkspacePlacement : null;
  }
  return resolvePersistedArchiveRetryPlacement(msg, workspaceRegistry, selectedProjectId);
}

async function resolveExplicitWorkspaceArchivePlacement(
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
  workspaceRegistry: Pick<WorkspaceRegistry, "list">,
): Promise<ExplicitWorkspaceArchivePlacement> {
  const workspace = (await workspaceRegistry.list()).find(
    (candidate) => candidate.workspaceId === msg.workspaceId,
  );
  if (!workspace) {
    throw new Error(`Workspace not found: ${msg.workspaceId}`);
  }
  if (msg.projectId && workspace.projectId !== msg.projectId) {
    throw new Error("workspaceId does not identify the selected project and worktree path");
  }
  if (msg.branchName && workspace.branch !== msg.branchName) {
    throw new Error("workspaceId does not identify the selected branch");
  }
  if (
    msg.worktreePath &&
    ![workspace.worktreeRoot, workspace.cwd]
      .filter((candidate): candidate is string => candidate !== null)
      .some((candidate) => createRealpathAwarePathMatcher(candidate)(msg.worktreePath!))
  ) {
    throw new Error("workspaceId does not identify the selected project and worktree path");
  }
  return {
    projectId: workspace.projectId,
    worktreePath: workspace.worktreeRoot ?? workspace.cwd,
    mainRepoRoot: workspace.mainRepoRoot,
    workspaceIds: [workspace.workspaceId],
    archiveCleanupPhase: workspace.archiveCleanupPhase,
    archivedAt: workspace.archivedAt,
  };
}

async function resolvePersistedArchiveRetryPlacement(
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
  workspaceRegistry: Pick<WorkspaceRegistry, "list">,
  selectedProjectId?: string,
): Promise<PersistedArchiveRetryPlacement | null> {
  if (msg.worktreePath && !isAbsolute(msg.worktreePath)) {
    return null;
  }

  const workspaces = await workspaceRegistry.list();
  const archivedWorktrees = workspaces.filter(
    (workspace) =>
      workspace.archivedAt !== null &&
      workspace.kind === "worktree" &&
      workspace.isPaseoOwnedWorktree &&
      workspace.worktreeRoot !== null,
  );
  const explicitWorkspace = msg.workspaceId
    ? workspaces.find((workspace) => workspace.workspaceId === msg.workspaceId)
    : null;
  if (explicitWorkspace && explicitWorkspace.archivedAt === null) {
    return null;
  }

  const candidates = archivedWorktrees.filter((workspace) => {
    if (selectedProjectId && workspace.projectId !== selectedProjectId) return false;
    if (msg.workspaceId && workspace.workspaceId !== msg.workspaceId) return false;
    if (msg.projectId && workspace.projectId !== msg.projectId) return false;
    if (msg.branchName && workspace.branch !== msg.branchName) return false;
    if (
      msg.repoRoot &&
      (!workspace.mainRepoRoot ||
        !createRealpathAwarePathMatcher(workspace.mainRepoRoot)(msg.repoRoot))
    ) {
      return false;
    }
    if (
      msg.worktreePath &&
      ![workspace.worktreeRoot, workspace.cwd].some(
        (candidate) =>
          candidate !== null && createRealpathAwarePathMatcher(candidate)(msg.worktreePath!),
      )
    ) {
      return false;
    }
    return true;
  });

  if (msg.workspaceId && explicitWorkspace?.archivedAt && candidates.length === 0) {
    throw new Error("workspaceId does not identify the selected project and worktree path");
  }
  if (candidates.length === 0) {
    return null;
  }

  const placements = new Map<string, PersistedArchiveRetryPlacement>();
  for (const workspace of candidates) {
    const key = `${workspace.projectId}\0${workspace.worktreeRoot}`;
    const existing = placements.get(key);
    placements.set(key, {
      projectId: workspace.projectId,
      worktreePath: workspace.worktreeRoot!,
      mainRepoRoot: workspace.mainRepoRoot,
      workspaceIds: [...(existing?.workspaceIds ?? []), workspace.workspaceId],
      archiveCleanupPhase:
        existing?.archiveCleanupPhase === "ready_to_delete" ||
        workspace.archiveCleanupPhase === "ready_to_delete"
          ? "ready_to_delete"
          : null,
    });
  }
  if (placements.size !== 1) {
    throw new Error("Archived workspace placement does not uniquely identify a worktree");
  }
  return [...placements.values()][0]!;
}

export async function validateExplicitWorkspaceArchiveTarget(input: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  workspaceId: string;
  projectId: string;
  worktreePath: string;
}): Promise<void> {
  const workspace = (await input.workspaceRegistry.list()).find(
    (candidate) => candidate.workspaceId === input.workspaceId,
  );
  if (!workspace || workspace.archivedAt !== null) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }
  const matchesPath = createRealpathAwarePathMatcher(input.worktreePath);
  if (
    workspace.projectId !== input.projectId ||
    ![workspace.worktreeRoot, workspace.cwd]
      .filter((candidate): candidate is string => candidate !== null)
      .some(matchesPath)
  ) {
    throw new Error("workspaceId does not identify the selected project and worktree path");
  }
}

export async function handleCreatePaseoWorktreeRequest(
  dependencies: HandleCreatePaseoWorktreeRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
): Promise<void> {
  try {
    const repository = await resolveWorktreeRepositoryIdentity(
      request,
      dependencies.projectRegistry,
      {
        workspaceRegistry: dependencies.workspaceRegistry,
        workspaceGitService: dependencies.workspaceGitService,
      },
    );
    const commandResult = await createPaseoWorktreeCommand(
      {
        paseoHome: dependencies.paseoHome,
        worktreesRoot: dependencies.worktreesRoot,
        createPaseoWorktreeWorkflow: dependencies.createPaseoWorktreeWorkflow,
      },
      {
        cwd: repository.repoRoot,
        projectId: repository.projectId,
        worktreeSlug: request.worktreeSlug,
        firstAgentContext: normalizeFirstAgentContext(request),
        refName: request.refName,
        action: request.action,
        checkoutSource: request.checkoutSource,
        githubPrNumber: request.githubPrNumber,
      },
    );

    if (!commandResult.ok) {
      dependencies.sessionLogger.error(
        { err: commandResult.cause, cwd: request.cwd, worktreeSlug: request.worktreeSlug },
        "Failed to create worktree",
      );
      dependencies.emit({
        type: "create_paseo_worktree_response",
        payload: {
          workspace: null,
          error: commandResult.error.message,
          errorCode: commandResult.error.code,
          setupTerminalId: null,
          requestId: request.requestId,
        },
      });
      return;
    }

    const createdWorktree = commandResult.createdWorktree;
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

interface PartialArchiveRetryContext {
  projectId: string;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  paseoHome?: string;
  worktreesRoot?: string;
  branchName?: string;
}

export async function resolveRepositoryWorktreePath(
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">,
  repoRoot: string,
  worktreePath: string | undefined,
  branchName: string | undefined,
  retryContext?: PartialArchiveRetryContext,
): Promise<string> {
  const worktrees = await workspaceGitService.listWorktrees(repoRoot, {
    force: true,
    reason: "archive-worktree-membership",
  });

  if (!worktreePath) {
    if (!branchName) {
      throw new Error("worktreePath or branchName is required for a repository-scoped archive");
    }
    const branchMatches = worktrees.filter((worktree) => worktree.branchName === branchName);
    if (branchMatches.length !== 1) {
      throw new Error(
        "branchName does not uniquely identify a worktree for the selected repository",
      );
    }
    return branchMatches[0]!.path;
  }

  const canonicalTarget = canonicalizeExistingRoot(worktreePath);
  if (!canonicalTarget) {
    throw new Error("worktreePath must be an existing absolute path on the daemon host");
  }
  const matchingWorktrees = worktrees.filter(
    (worktree) => canonicalizeExistingRoot(worktree.path) === canonicalTarget,
  );
  if (matchingWorktrees.length > 1) {
    throw new Error("worktreePath is not a worktree for the selected repository");
  }
  if (matchingWorktrees.length === 0) {
    if (retryContext && (await resolvePartialArchiveRetryPath(canonicalTarget, retryContext))) {
      return canonicalTarget;
    }
    throw new Error("worktreePath is not a worktree for the selected repository");
  }
  const worktree = matchingWorktrees[0]!;
  if (branchName && worktree.branchName !== branchName) {
    throw new Error("worktreePath and branchName do not identify the same worktree");
  }
  return worktree.path;
}

async function resolvePartialArchiveRetryPath(
  canonicalTarget: string,
  context: PartialArchiveRetryContext,
): Promise<boolean> {
  const ownership = await isPaseoOwnedWorktreeCwd(canonicalTarget, {
    paseoHome: context.paseoHome,
    worktreesRoot: context.worktreesRoot,
  });
  if (
    !ownership.allowed ||
    !ownership.worktreePath ||
    !createRealpathAwarePathMatcher(canonicalTarget)(ownership.worktreePath)
  ) {
    return false;
  }

  const matchesTarget = createRealpathAwarePathMatcher(canonicalTarget);
  return (await context.workspaceRegistry.list()).some(
    (workspace) =>
      workspace.projectId === context.projectId &&
      (!context.branchName || workspace.branch === context.branchName) &&
      [workspace.worktreeRoot, workspace.cwd]
        .filter((candidate): candidate is string => candidate !== null)
        .some(matchesTarget),
  );
}

export async function createPaseoWorktreeWorkflow(
  dependencies: CreatePaseoWorktreeWorkflowDependencies,
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
  },
): Promise<CreatePaseoWorktreeWorkflowResult> {
  const createdWorktree = await dependencies.createPaseoWorktree(
    {
      ...input,
      runSetup: false,
      paseoHome: input.paseoHome ?? dependencies.paseoHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    },
    options?.resolveDefaultBranch
      ? { resolveDefaultBranch: options.resolveDefaultBranch }
      : undefined,
  );
  const slug = basename(createdWorktree.worktree.worktreePath);
  const workspace = createdWorktree.workspace;
  const setupContinuation = options?.setupContinuation ?? { kind: "workspace" };

  setTimeout(() => {
    if (input.firstAgentContext) {
      dependencies.autoNameWorkspaceBranchForFirstAgent({
        workspace,
        firstAgentContext: input.firstAgentContext,
      });
    }
    void dependencies.warmWorkspaceGitData(workspace).catch((error) => {
      dependencies.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm workspace git data after creating worktree",
      );
    });
    if (setupContinuation.kind === "workspace") {
      void runWorktreeSetupInBackground(dependencies, {
        requestCwd: input.cwd,
        repoRoot: createdWorktree.repoRoot,
        workspaceId: workspace.workspaceId,
        worktree: createdWorktree.worktree,
        shouldBootstrap: createdWorktree.created,
        slug,
        worktreePath: createdWorktree.worktree.worktreePath,
        workspaceCwd: workspace.cwd,
      });
    }
  }, 0);

  if (setupContinuation.kind === "agent") {
    return {
      ...createdWorktree,
      setupContinuation: {
        kind: "agent",
        startAfterAgentCreate: ({ agentId }) => {
          void runAsyncWorktreeBootstrap({
            agentId,
            workspaceId: workspace.workspaceId,
            worktree: createdWorktree.worktree,
            workspaceCwd: workspace.cwd,
            shouldBootstrap: createdWorktree.created,
            terminalManager: setupContinuation.terminalManager,
            appendTimelineItem: (item) => setupContinuation.appendTimelineItem({ agentId, item }),
            emitLiveTimelineItem: (item) =>
              setupContinuation.emitLiveTimelineItem({ agentId, item }),
            logger: setupContinuation.logger,
          });
        },
      },
    };
  }

  return createdWorktree;
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
    workspaceCwd?: string;
  },
): Promise<void> {
  let worktree: WorktreeConfig = options.worktree;
  let setupResults: WorktreeSetupCommandResult[] = [];
  let setupStarted = false;
  const progressAccumulator = createWorktreeSetupProgressAccumulator();
  const workspaceId = options.workspaceId;

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
        const workspaceCwd = options.workspaceCwd ?? worktree.worktreePath;
        const setupCommands = getWorktreeSetupCommands(workspaceCwd);
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
            cwd: workspaceCwd,
            env: runtimeEnv,
          });
          setupStarted = true;
          setupResults = await runWorktreeSetupCommands({
            worktreePath: workspaceCwd,
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
    await dependencies.emitWorkspaceUpdateForWorkspaceId(options.workspaceId);
  }
}
