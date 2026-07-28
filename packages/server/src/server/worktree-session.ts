import type { Logger } from "pino";
import { basename } from "node:path";

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
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  applyWorktreeSetupProgressEvent,
  buildWorktreeSetupDetail,
  createWorktreeSetupProgressAccumulator,
  getWorktreeSetupProgressResults,
  runWorktreeTerminalsAfterSetup,
} from "./worktree-bootstrap.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { CheckoutExistingBranchResult } from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import {
  getWorktreeSetupCommands,
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
import type { WorkspaceSetupReadiness } from "./workspace-setup-readiness.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { GeneratedWorkspaceName } from "./worktree-branch-name-generator.js";

const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SETUP_PROGRESS_EMIT_INTERVAL_MS = 100;

export class WorkspaceSetupExecutionError extends Error {
  constructor(
    readonly setupStarted: boolean,
    readonly setupError: unknown,
  ) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    super(detail, { cause: setupError });
    this.name = "WorkspaceSetupExecutionError";
  }
}

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
  typeof runWorktreeTerminalsAfterSetup
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
  cacheWorkspaceSetupSnapshot: (
    workspaceId: string,
    snapshot: WorkspaceSetupSnapshot,
  ) => readonly string[] | void;
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
  generateWorkspaceNameForFirstAgent: (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => Promise<GeneratedWorkspaceName | null>;
  workspaceSetupReadiness: Pick<WorkspaceSetupReadiness, "start" | "waitUntilReady">;
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
  workspaceSetupReadiness: Pick<WorkspaceSetupReadiness, "getSnapshot">;
}

interface HandleCreatePaseoWorktreeRequestDependencies {
  paseoHome?: string;
  worktreesRoot?: string;
  describeWorkspaceRecord: (
    result: CreatePaseoWorktreeResult,
  ) => Promise<WorkspaceDescriptorPayload>;
  emit: EmitSessionMessage;
  sessionLogger: Logger;
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
  createdWorktree?: CreatePaseoWorktreeWorkflowResult;
}> {
  let cwd = expandTilde(config.cwd);
  const normalized = normalizeGitOptions(gitOptions, legacyWorktreeName);
  let setupContinuation: AgentWorktreeSetupContinuation | undefined;
  let createdWorkspaceId: string | undefined;
  let createdWorktreeResult: CreatePaseoWorktreeWorkflowResult | undefined;

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
        title: config.title?.trim() || undefined,
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
    createdWorktreeResult = createdWorktree;
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
    createdWorktree: createdWorktreeResult,
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
  // COMPAT(githubPrNumber): legacy GitHub checkout input retained when
  // checkoutSource shipped in v0.2.0-beta.1. Remove after 2027-01-17 once the
  // supported client floor is >= v0.2.0.
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
    const worktrees = await listPaseoWorktreesCommand(
      { workspaceGitService: dependencies.workspaceGitService },
      { cwd },
    );
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

export async function handlePaseoWorktreeArchiveRequest(
  dependencies: Omit<
    ArchiveDependencies,
    "emitWorkspaceUpdatesForWorkspaceIds" | "workspaceGitService"
  > & {
    emit: EmitSessionMessage;
    workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
    emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
): Promise<void> {
  const { requestId } = msg;

  try {
    const result = await archiveCommand(dependencies, {
      requestId,
      worktreePath: msg.worktreePath,
      repoRoot: msg.repoRoot,
      branchName: msg.branchName,
      workspaceId: msg.workspaceId,
      scope: msg.scope,
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

export async function handleCreatePaseoWorktreeRequest(
  dependencies: HandleCreatePaseoWorktreeRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
): Promise<void> {
  try {
    const commandResult = await createPaseoWorktreeCommand(
      {
        paseoHome: dependencies.paseoHome,
        worktreesRoot: dependencies.worktreesRoot,
        createPaseoWorktreeWorkflow: dependencies.createPaseoWorktreeWorkflow,
      },
      {
        cwd: request.cwd,
        projectId: request.projectId,
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

export async function createPaseoWorktreeWorkflow(
  dependencies: CreatePaseoWorktreeWorkflowDependencies,
  input: CreatePaseoWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
  },
): Promise<CreatePaseoWorktreeWorkflowResult> {
  const prepared = await prepareFirstAgentWorktreeName(dependencies, input);
  const createdWorktree = await dependencies.createPaseoWorktree(
    {
      ...prepared.input,
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

  await dependencies.workspaceSetupReadiness.start(
    workspace.workspaceId,
    createdWorktree.worktree.worktreePath,
    (signal) =>
      runWorktreeSetupInBackground(dependencies, {
        requestCwd: input.cwd,
        repoRoot: createdWorktree.repoRoot,
        workspaceId: workspace.workspaceId,
        worktree: createdWorktree.worktree,
        shouldBootstrap: createdWorktree.created,
        archiveOnFailure: setupContinuation.kind !== "agent",
        slug,
        worktreePath: createdWorktree.worktree.worktreePath,
        workspaceCwd: workspace.cwd,
        signal,
      }),
  );

  const firstAgentContext = prepared.input.firstAgentContext;
  if (firstAgentContext && !prepared.generatedBeforeCreate) {
    try {
      dependencies.autoNameWorkspaceBranchForFirstAgent({
        workspace,
        firstAgentContext,
      });
    } catch (error) {
      dependencies.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to schedule workspace auto-name",
      );
    }
  }

  setTimeout(() => {
    void dependencies.warmWorkspaceGitData(workspace).catch((error) => {
      dependencies.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm workspace git data after creating worktree",
      );
    });
  }, 0);

  if (setupContinuation.kind === "agent") {
    return {
      ...createdWorktree,
      setupContinuation: {
        kind: "agent",
        startAfterAgentCreate: ({ agentId }) => {
          void dependencies.workspaceSetupReadiness
            .waitUntilReady(workspace.workspaceId)
            .then(() =>
              runWorktreeTerminalsAfterSetup({
                agentId,
                workspaceId: workspace.workspaceId,
                worktree: createdWorktree.worktree,
                workspaceCwd: workspace.cwd,
                shouldBootstrap: createdWorktree.created,
                terminalManager: setupContinuation.terminalManager,
                appendTimelineItem: (item) =>
                  setupContinuation.appendTimelineItem({ agentId, item }),
                emitLiveTimelineItem: (item) =>
                  setupContinuation.emitLiveTimelineItem({ agentId, item }),
                logger: setupContinuation.logger,
              }),
            )
            .catch((error) => {
              setupContinuation.logger.warn(
                { err: error, workspaceId: workspace.workspaceId, agentId },
                "Failed to start worktree terminals after setup",
              );
            });
        },
      },
    };
  }

  return createdWorktree;
}

async function prepareFirstAgentWorktreeName(
  dependencies: Pick<CreatePaseoWorktreeWorkflowDependencies, "generateWorkspaceNameForFirstAgent">,
  input: CreatePaseoWorktreeInput,
): Promise<{ input: CreatePaseoWorktreeInput; generatedBeforeCreate: boolean }> {
  const firstAgentContext = input.firstAgentContext;
  const createsNewBranch =
    input.action !== "checkout" &&
    input.checkoutSource === undefined &&
    input.githubPrNumber === undefined;
  if (
    !createsNewBranch ||
    input.branchName?.trim() ||
    !firstAgentContext ||
    !buildAgentBranchNameSeed(firstAgentContext)
  ) {
    return { input, generatedBeforeCreate: false };
  }

  const generated = await dependencies.generateWorkspaceNameForFirstAgent({
    cwd: input.cwd,
    firstAgentContext,
  });
  const branchName = generated?.branch?.trim();
  const title = generated?.title?.trim();
  if (!branchName || !title || slugify(branchName) !== branchName) {
    throw new Error("Couldn't generate a valid name for this workspace. Retry workspace creation.");
  }

  return {
    input: {
      ...input,
      branchName,
      worktreeSlug: branchName,
      title: input.title?.trim() || title,
      nameSource: "first-agent",
    },
    generatedBeforeCreate: true,
  };
}

export async function handleWorkspaceSetupStatusRequest(
  dependencies: HandleWorkspaceSetupStatusRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
): Promise<void> {
  const workspaceId = request.workspaceId;
  const snapshot = dependencies.workspaceSetupReadiness.getSnapshot(workspaceId);

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
    archiveOnFailure?: boolean;
    slug: string;
    worktreePath: string;
    workspaceCwd?: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  let worktree: WorktreeConfig = options.worktree;
  let setupResults: WorktreeSetupCommandResult[] = [];
  let setupStarted = false;
  const progressAccumulator = createWorktreeSetupProgressAccumulator();
  const workspaceId = options.workspaceId;
  let pendingProgressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProgressEmittedAt = 0;

  const emitSetupProgressNow = (
    status: "running" | "completed" | "failed",
    error: string | null,
  ) => {
    if (pendingProgressTimer) {
      clearTimeout(pendingProgressTimer);
      pendingProgressTimer = null;
    }
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
    const cachedWorkspaceIds = dependencies.cacheWorkspaceSetupSnapshot(workspaceId, snapshot);
    const relatedWorkspaceIds = Array.isArray(cachedWorkspaceIds)
      ? cachedWorkspaceIds
      : [workspaceId];
    for (const relatedWorkspaceId of relatedWorkspaceIds) {
      dependencies.emit({
        type: "workspace_setup_progress",
        payload: {
          workspaceId: relatedWorkspaceId,
          ...snapshot,
        },
      });
    }
    lastProgressEmittedAt = Date.now();
  };

  const emitRunningSetupProgress = () => {
    const elapsed = Date.now() - lastProgressEmittedAt;
    if (lastProgressEmittedAt === 0 || elapsed >= SETUP_PROGRESS_EMIT_INTERVAL_MS) {
      emitSetupProgressNow("running", null);
      return;
    }
    if (pendingProgressTimer) {
      return;
    }
    pendingProgressTimer = setTimeout(() => {
      pendingProgressTimer = null;
      emitSetupProgressNow("running", null);
    }, SETUP_PROGRESS_EMIT_INTERVAL_MS - elapsed);
  };

  try {
    try {
      emitRunningSetupProgress();

      if (!options.shouldBootstrap) {
        emitSetupProgressNow("completed", null);
      } else {
        const workspaceCwd = options.workspaceCwd ?? worktree.worktreePath;
        const setupCommands = getWorktreeSetupCommands(workspaceCwd);
        if (setupCommands.length === 0) {
          setupStarted = true;
          emitSetupProgressNow("completed", null);
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
            signal: options.signal,
            onEvent: (event) => {
              applyWorktreeSetupProgressEvent(progressAccumulator, event);
              emitRunningSetupProgress();
            },
          });
          emitSetupProgressNow("completed", null);
        }
      }
    } catch (error) {
      if (error instanceof WorktreeSetupError) {
        setupResults = error.results;
      }
      const message = error instanceof Error ? error.message : String(error);
      emitSetupProgressNow("failed", message);

      if (!setupStarted && options.archiveOnFailure !== false) {
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
      throw new WorkspaceSetupExecutionError(setupStarted, error);
    }
  } finally {
    await dependencies.emitWorkspaceUpdateForWorkspaceId(options.workspaceId);
  }
}
