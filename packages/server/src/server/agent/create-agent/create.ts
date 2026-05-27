import type { Logger } from "pino";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  AgentWorktreeSetupContinuation,
  CreatePaseoWorktreeSetupContinuationInput,
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext, GitSetupOptions } from "../../messages.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import { scheduleAgentMetadataGeneration } from "../agent-metadata-generator.js";
import type {
  AgentProvider,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { AgentStorage } from "../agent-storage.js";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { ProviderDefinition } from "../provider-registry.js";
import { setupFinishNotification, startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import { resolveAndValidateCreateAgentMode } from "../create-agent-mode.js";
import { resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "../timeline-append.js";

const OPENCODE_PROVIDER_ID = "opencode";
const OPENCODE_BUILD_MODE_ID = "build";
const OPENCODE_LEGACY_FULL_ACCESS_MODE_ID = "full-access";
const OPENCODE_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

function isOpenCodeLegacyFullAccessMode(
  provider: AgentProvider,
  modeId: string | undefined,
): boolean {
  return provider === OPENCODE_PROVIDER_ID && modeId === OPENCODE_LEGACY_FULL_ACCESS_MODE_ID;
}

function withOpenCodeAutoAcceptFeature(
  features: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...features,
    [OPENCODE_AUTO_ACCEPT_FEATURE_ID]: enabled,
  };
}

function hasOpenCodeAutoAcceptFeature(agent: ManagedAgent): boolean {
  if (agent.provider !== OPENCODE_PROVIDER_ID) {
    return false;
  }
  return (
    agent.features?.some(
      (feature) =>
        feature.id === OPENCODE_AUTO_ACCEPT_FEATURE_ID &&
        (feature.value === true || feature.value === "true"),
    ) === true || agent.config.featureValues?.[OPENCODE_AUTO_ACCEPT_FEATURE_ID] === true
  );
}

function isAgentInUnattendedState(
  dependencies: CreateAgentCommandDependencies,
  agent: ManagedAgent,
): boolean {
  return (
    isParentInUnattendedMode(dependencies, agent.provider, agent.currentModeId) ||
    hasOpenCodeAutoAcceptFeature(agent)
  );
}

export interface CreateAgentWorkspace {
  workspaceId: string;
}

export interface CreateAgentSessionWorktreeResult {
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
}

interface CreateAgentCommandDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
  >;
  terminalManager?: TerminalManager | null;
  providerRegistry?: Record<AgentProvider, ProviderDefinition> | null;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
}

export interface CreateAgentFromSessionInput {
  kind: "session";
  config: AgentSessionConfig;
  workspaceId?: string;
  worktreeName?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  git?: GitSetupOptions;
  labels: Record<string, string>;
  env?: Record<string, string>;
  provisionalTitle: string | null;
  explicitTitle: string | null;
  firstAgentContext: FirstAgentContext;
  buildSessionConfig: (
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<CreateAgentSessionWorktreeResult>;
  resolveWorkspace: (input: { cwd: string; workspaceId?: string }) => Promise<CreateAgentWorkspace>;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  title: string;
  initialPrompt: string;
  cwd?: string;
  thinking?: string;
  features?: Record<string, unknown>;
  labels?: Record<string, string>;
  mode?: string;
  background: boolean;
  notifyOnFinish: boolean;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;
  worktree?: {
    worktreeName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  background: boolean;
  initialPromptStarted: boolean;
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions?: AgentCreateOptions;
  metadataInitialPrompt?: string;
  prompt?: AgentPromptInput;
  runOptions?: AgentRunOptions;
  explicitTitle: string | null;
  setupContinuation?: AgentWorktreeSetupContinuation;
  background: boolean;
  promptFailure: "throw" | "log";
  promptLogger?: Logger;
}

interface AgentCreateOptions {
  labels?: Record<string, string>;
  workspaceId?: string;
  initialPrompt?: string;
  env?: Record<string, string>;
  initialTitle?: string | null;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input)
      : await resolveMcpCreateAgent(dependencies, input);

  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    undefined,
    resolved.createOptions,
  );

  resolved.setupContinuation?.startAfterAgentCreate({
    agentId: snapshot.id,
  });

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  if (resolved.prompt !== undefined) {
    const sendResult = await sendInitialPrompt(dependencies, resolved, snapshot);
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
  }

  if (input.kind === "mcp" && input.notifyOnFinish && input.callerAgentId && initialPromptStarted) {
    setupFinishNotification({
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      childAgentId: snapshot.id,
      callerAgentId: input.callerAgentId,
      logger: dependencies.logger,
    });
  }

  return {
    snapshot,
    liveSnapshot,
    background: resolved.background,
    initialPromptStarted,
  };
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const { sessionConfig, setupContinuation } = await input.buildSessionConfig(
    input.config,
    input.git,
    input.worktreeName,
    input.firstAgentContext,
  );
  const workspace = await input.resolveWorkspace({
    cwd: sessionConfig.cwd,
    workspaceId: input.workspaceId,
  });
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      workspaceId: workspace.workspaceId,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
    },
    metadataInitialPrompt: trimmedPrompt,
    prompt: hasPromptContent ? prompt : undefined,
    runOptions: input.outputSchema ? { outputSchema: input.outputSchema } : undefined,
    explicitTitle: input.explicitTitle,
    setupContinuation,
    background: true,
    promptFailure: "throw",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveRequiredProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = parentAgent
    ? resolveChildAgentCwd({
        parentCwd: parentAgent.cwd,
        requestedCwd: input.cwd,
        lockedCwd: input.callerContext?.lockedCwd,
        allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
      })
    : expandUserPath(input.cwd ?? process.cwd());
  const { resolvedCwd, setupContinuation } = await resolveMcpCwd({
    dependencies,
    cwd,
    worktree: input.worktree,
    initialPrompt: input.initialPrompt,
  });

  const parentForResolve = parentAgent
    ? {
        provider: parentAgent.provider,
        modeId: parentAgent.currentModeId,
        isUnattended: isAgentInUnattendedState(dependencies, parentAgent),
      }
    : null;
  const { mode: resolvedMode, features: resolvedFeatures } = resolveCreateModeAndFeatures(
    dependencies,
    {
      provider,
      requestedMode: input.mode,
      parent: parentForResolve,
      features: input.features,
    },
  );

  const labels = mergeLabels(
    input.callerAgentId,
    input.callerContext?.childAgentDefaultLabels,
    input.labels,
  );

  const trimmedPrompt = input.initialPrompt.trim();
  return {
    config: {
      provider,
      cwd: resolvedCwd,
      modeId: resolvedMode,
      title: input.title.trim(),
      model: resolvedProviderModel.model,
      thinkingOptionId: input.thinking,
      ...(resolvedFeatures ? { featureValues: resolvedFeatures } : {}),
    },
    createOptions: labels ? { labels } : undefined,
    metadataInitialPrompt: trimmedPrompt,
    prompt: trimmedPrompt,
    explicitTitle: input.title.trim(),
    setupContinuation,
    background: input.background,
    promptFailure: "log",
  };
}

function resolveCreateModeAndFeatures(
  dependencies: CreateAgentCommandDependencies,
  input: {
    provider: AgentProvider;
    requestedMode: string | undefined;
    parent: { provider: AgentProvider; modeId: string | null; isUnattended: boolean } | null;
    features: Record<string, unknown> | undefined;
  },
): { mode: string | undefined; features: Record<string, unknown> | undefined } {
  const legacyOpenCodeFullAccess = isOpenCodeLegacyFullAccessMode(
    input.provider,
    input.requestedMode,
  );
  const inheritsOpenCodeUnattended =
    input.provider === OPENCODE_PROVIDER_ID &&
    input.requestedMode === undefined &&
    input.parent?.isUnattended === true;
  const inheritsOpenCodeAutoAccept =
    inheritsOpenCodeUnattended && input.features?.[OPENCODE_AUTO_ACCEPT_FEATURE_ID] === undefined;
  const requestedMode = legacyOpenCodeFullAccess ? OPENCODE_BUILD_MODE_ID : input.requestedMode;
  const features =
    legacyOpenCodeFullAccess || inheritsOpenCodeAutoAccept
      ? withOpenCodeAutoAcceptFeature(input.features, true)
      : input.features;
  const mode =
    inheritsOpenCodeUnattended && requestedMode === undefined
      ? OPENCODE_BUILD_MODE_ID
      : resolveAndValidateCreateAgentMode({
          requestedMode,
          targetProvider: input.provider,
          parent: input.parent,
          availableModes: getAvailableModeIds(dependencies, input.provider),
          targetUnattendedMode: getUnattendedModeId(dependencies, input.provider),
        });

  return { mode, features };
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent }> {
  scheduleAgentMetadataGeneration({
    agentManager: dependencies.agentManager,
    agentId: snapshot.id,
    cwd: snapshot.cwd,
    workspaceGitService: dependencies.workspaceGitService,
    initialPrompt: resolved.metadataInitialPrompt,
    explicitTitle: resolved.explicitTitle,
    paseoHome: dependencies.paseoHome,
    logger: dependencies.logger,
  });

  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentManager: dependencies.agentManager,
      agentId: snapshot.id,
      snapshot,
      prompt,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  attachments?: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  const hasImages = (images?.length ?? 0) > 0;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return normalized;
  }
  const blocks: AgentPromptContentBlock[] = [];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const attachment of attachments ?? []) {
    blocks.push(attachment);
  }
  return blocks;
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{ resolvedCwd: string; setupContinuation?: AgentWorktreeSetupContinuation }> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      worktreeSlug: worktree.worktreeName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      ...(params.initialPrompt ? { firstAgentContext: { prompt: params.initialPrompt } } : {}),
      runSetup: false,
      paseoHome: dependencies.paseoHome,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    setupContinuation: {
      kind: "agent",
      terminalManager: dependencies.terminalManager ?? null,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      logger: dependencies.logger,
    },
  });
  return {
    resolvedCwd: createdWorktree.worktree.worktreePath,
    setupContinuation: createdWorktree.setupContinuation,
  };
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}

function mergeLabels(
  callerAgentId: string | undefined,
  childAgentDefaultLabels: Record<string, string> | undefined,
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const mergedLabels = {
    ...(callerAgentId ? { [PARENT_AGENT_ID_LABEL]: callerAgentId } : {}),
    ...childAgentDefaultLabels,
    ...labels,
  };
  return Object.keys(mergedLabels).length > 0 ? mergedLabels : undefined;
}

function getProviderModes(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): ProviderDefinition["modes"] | undefined {
  const fromRegistry = dependencies.providerRegistry?.[provider];
  if (fromRegistry) {
    return fromRegistry.modes;
  }
  try {
    return getAgentProviderDefinition(provider).modes;
  } catch {
    return undefined;
  }
}

function getAvailableModeIds(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): string[] | undefined {
  return getProviderModes(dependencies, provider)?.map((mode) => mode.id);
}

function getUnattendedModeId(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): string | undefined {
  return getProviderModes(dependencies, provider)?.find((mode) => mode.isUnattended)?.id;
}

function isParentInUnattendedMode(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
  modeId: string | null,
): boolean {
  if (modeId === null) {
    return false;
  }
  const modes = getProviderModes(dependencies, provider);
  if (!modes) {
    return false;
  }
  return modes.some((mode) => mode.id === modeId && mode.isUnattended === true);
}
