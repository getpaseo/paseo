import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureValidJson } from "../json-utils.js";
import type { Logger } from "pino";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, WaitForAgentResult } from "./agent-manager.js";
import {
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
} from "../messages.js";
import type { AgentListItemPayload } from "../messages.js";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
} from "./agent-projections.js";
import { curateAgentActivity } from "./activity-curator.js";
import { selectItemsByProjectedLimit } from "./timeline-projection.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStoredAgentProviderAvailable } from "../persistence-hooks.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./timeline-append.js";
import { getPaseoWorktreesRoot } from "../../utils/worktree.js";
import {
  archivePaseoWorktree,
  killTerminalsUnderPath,
  type ArchivePaseoWorktreeDependencies,
} from "../paseo-worktree-archive-service.js";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";
import { scheduleAgentMetadataGeneration } from "./agent-metadata-generator.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../voice-types.js";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../path-utils.js";
import { PARENT_AGENT_ID_LABEL } from "../../shared/agent-labels.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type {
  AgentWorktreeSetupContinuation,
  CreatePaseoWorktreeSetupContinuationInput,
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../worktree-session.js";
import type { ScheduleService } from "../schedule/service.js";
import { ScheduleSummarySchema, StoredScheduleSchema } from "../schedule/types.js";
import type { ProviderDefinition } from "./provider-registry.js";
import { getAgentProviderDefinition } from "./provider-manifest.js";
import { resolveAndValidateCreateAgentMode } from "./create-agent-mode.js";
import { resolveSnapshotCwd } from "./provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
  waitForAgentWithTimeout,
} from "./mcp-shared.js";
import { sendPromptToAgent, setupFinishNotification, startAgentRun } from "./agent-prompt.js";
import type { GitHubService } from "../../services/github-service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { CreatePaseoWorktreeInput } from "../paseo-worktree-service.js";
import { toWorktreeRequestError } from "../worktree-errors.js";
import { join } from "node:path";

export interface AgentMcpServerOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  providerRegistry?: Record<AgentProvider, ProviderDefinition> | null;
  github?: GitHubService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
  >;
  archiveWorkspaceRecord?: ArchivePaseoWorktreeDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchivePaseoWorktreeDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  markWorkspaceArchiving?: ArchivePaseoWorktreeDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchivePaseoWorktreeDependencies["clearWorkspaceArchiving"];
  emitSessionMessage?: ArchivePaseoWorktreeDependencies["emit"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  paseoHome?: string;
  /**
   * ID of the agent that is connecting to this MCP server.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  logger: Logger;
}

const CLAUDE_TO_CODEX_MODE: Record<string, string> = {
  plan: "read-only",
  default: "auto",
  acceptEdits: "auto",
  bypassPermissions: "full-access",
};

const CODEX_TO_CLAUDE_MODE: Record<string, string> = {
  "read-only": "plan",
  auto: "default",
  "full-access": "bypassPermissions",
};

function mapModeAcrossProviders(
  sourceMode: string,
  sourceProvider: AgentProvider,
  targetProvider: AgentProvider,
): string {
  if (sourceProvider === targetProvider) {
    return sourceMode;
  }

  if (sourceProvider === "claude" && targetProvider === "codex") {
    const mapped = CLAUDE_TO_CODEX_MODE[sourceMode];
    if (mapped) {
      return mapped;
    }
    return "auto";
  }

  if (sourceProvider === "codex" && targetProvider === "claude") {
    const mapped = CODEX_TO_CLAUDE_MODE[sourceMode];
    if (mapped) {
      return mapped;
    }
    return "default";
  }

  return sourceMode;
}

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveAgentListActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    parseTimestamp(agent.updatedAt),
    parseTimestamp(agent.lastUserMessageAt),
    parseTimestamp(agent.attentionTimestamp),
    parseTimestamp(agent.archivedAt),
    parseTimestamp(agent.createdAt),
  );
}

function resolveRegisteredProviderIds(
  agentManager: AgentManager,
  providerRegistry: Record<AgentProvider, ProviderDefinition> | null | undefined,
): AgentProvider[] {
  return providerRegistry ? Object.keys(providerRegistry) : agentManager.getRegisteredProviderIds();
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: ProviderDefinition["modes"];
  status: string;
  error?: string;
}

async function resolveProviderSummary(
  provider: ProviderDefinition,
  logger: Logger,
): Promise<ProviderSummary> {
  const base = {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    modes: provider.modes,
  };
  if (!provider.enabled) {
    return { ...base, enabled: false, status: "unavailable" };
  }
  try {
    const available = await provider.createClient(logger).isAvailable();
    return { ...base, enabled: true, status: available ? "available" : "unavailable" };
  } catch (availabilityError) {
    return {
      ...base,
      enabled: true,
      status: "unavailable",
      error:
        availabilityError instanceof Error ? availabilityError.message : String(availabilityError),
    };
  }
}

function compareAgentListItems(a: AgentListItemPayload, b: AgentListItemPayload): number {
  const attentionDelta =
    Number(b.requiresAttention ?? false) - Number(a.requiresAttention ?? false);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as Record<string, number>;
  const statusDelta = (statusOrder[a.status] ?? 999) - (statusOrder[b.status] ?? 999);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return resolveAgentListActivityTime(b) - resolveAgentListActivityTime(a);
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
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

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

const WorktreeSummarySchema = z.object({
  path: z.string(),
  createdAt: z.string(),
  branchName: z.string().optional(),
  head: z.string().optional(),
});

function resolveTerminalKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    scheduleService,
    providerRegistry,
    callerAgentId,
    resolveSpeakHandler,
    resolveCallerContext,
    logger,
  } = options;
  const childLogger = logger.child({ module: "agent", component: "mcp-server" });
  const waitTracker = new WaitForAgentTracker(logger);
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;

  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new Error("cwd is required");
      }
      throw new Error("cwd is required when no caller agent is available");
    }

    return expandUserPath(trimmedCwd);
  };

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.config.approvalPolicy
        ? { approvalPolicy: callerAgent.config.approvalPolicy }
        : {}),
      ...(callerAgent.config.sandboxMode ? { sandboxMode: callerAgent.config.sandboxMode } : {}),
      ...(typeof callerAgent.config.networkAccess === "boolean"
        ? { networkAccess: callerAgent.config.networkAccess }
        : {}),
      ...(typeof callerAgent.config.webSearch === "boolean"
        ? { webSearch: callerAgent.config.webSearch }
        : {}),
      ...(callerAgent.config.title ? { title: callerAgent.config.title } : {}),
      ...(callerAgent.config.extra ? { extra: callerAgent.config.extra } : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId
        ? {
            modeId: mapModeAcrossProviders(
              callerAgent.currentModeId,
              callerAgent.provider,
              resolvedProvider,
            ),
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: { provider?: string; cwd?: string }) => {
    if (!params?.provider?.trim()) {
      throw new Error("provider is required when target is new-agent");
    }

    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: buildCallerAgentScheduleConfig(callerAgent, params),
      };
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
      },
    };
  };
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const agentToAgentInputSchema = {
    cwd: z
      .string()
      .optional()
      .describe("Optional working directory. Defaults to the caller agent working directory."),
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.describe(
      "Required provider/model pair, for example codex/gpt-5.4.",
    ),
    thinking: z.string().optional().describe("Thinking option ID"),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
    mode: z
      .string()
      .optional()
      .describe(
        "Optional session mode for the new agent. Required when the new agent uses a different provider than the caller agent.",
      ),
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Send a notification prompt to the caller agent when this agent finishes, errors, or needs permission. Requires a caller agent context.",
      ),
  };

  const topLevelInputSchema = {
    cwd: z
      .string()
      .describe("Required working directory for the agent (absolute, relative, or ~)."),
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.describe(
      "Required provider/model pair, for example codex/gpt-5.4.",
    ),
    thinking: z.string().optional().describe("Thinking option ID"),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
    mode: z
      .string()
      .optional()
      .describe("Optional session mode to configure before the first run."),
    worktreeName: z
      .string()
      .optional()
      .describe("Optional git worktree branch name (lowercase alphanumerics + hyphen)."),
    baseBranch: z
      .string()
      .optional()
      .describe("Required when worktreeName is set: the base branch to diff/merge against."),
    refName: z.string().min(1).optional().describe("Optional source ref for worktree creation."),
    action: z
      .enum(["branch-off", "checkout"])
      .optional()
      .describe("Optional worktree creation action."),
    githubPrNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional GitHub pull request number to checkout."),
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Send a notification prompt to the caller agent when this agent finishes, errors, or needs permission. Requires a caller agent context.",
      ),
  };

  const createAgentInputSchema = callerAgentId ? agentToAgentInputSchema : topLevelInputSchema;
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const topLevelCreateAgentArgsSchema = z.object(topLevelInputSchema).strict();

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    server.registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context?: McpToolContext) => {
        if (!callerAgentId) {
          throw new Error("speak is only available to agent-scoped MCP sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new Error(`No speak handler registered for caller agent '${callerAgentId}'`);
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return server;
  }

  interface ResolvedCreateAgentArgs {
    provider: AgentProvider;
    initialPrompt: string;
    background: boolean;
    normalizedTitle: string | null;
    model: string | undefined;
    thinking: string | undefined;
    labels: Record<string, string> | undefined;
    notifyOnFinish: boolean;
    resolvedCwd: string;
    resolvedMode: string | undefined;
    setupContinuation: AgentWorktreeSetupContinuation | undefined;
  }

  const getProviderModes = (provider: AgentProvider) => {
    const fromRegistry = providerRegistry?.[provider];
    if (fromRegistry) {
      return fromRegistry.modes;
    }
    try {
      return getAgentProviderDefinition(provider).modes;
    } catch {
      return undefined;
    }
  };

  const getAvailableModeIds = (provider: AgentProvider): string[] | undefined => {
    return getProviderModes(provider)?.map((mode) => mode.id);
  };

  const getUnattendedModeId = (provider: AgentProvider): string | undefined => {
    return getProviderModes(provider)?.find((mode) => mode.isUnattended)?.id;
  };

  const isParentInUnattendedMode = (provider: AgentProvider, modeId: string | null): boolean => {
    if (modeId === null) return false;
    const modes = getProviderModes(provider);
    if (!modes) return false;
    return modes.some((mode) => mode.id === modeId && mode.isUnattended === true);
  };

  const resolveCallerCreateAgentArgs = (
    args: unknown,
    parentAgentId: string,
  ): ResolvedCreateAgentArgs => {
    const callerArgs = agentToAgentCreateAgentArgsSchema.parse(args);
    const resolvedProviderModel = resolveRequiredProviderModel(callerArgs.provider);
    const parentAgent = agentManager.getAgent(parentAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${parentAgentId} not found`);
    }
    const provider = resolvedProviderModel.provider;
    const resolvedCwd = resolveChildAgentCwd({
      parentCwd: parentAgent.cwd,
      requestedCwd: callerArgs.cwd,
      lockedCwd: callerContext?.lockedCwd,
      allowCustomCwd: callerContext?.allowCustomCwd ?? true,
    });
    const resolvedMode = resolveAndValidateCreateAgentMode({
      requestedMode: callerArgs.mode,
      targetProvider: provider,
      parent: {
        provider: parentAgent.provider,
        modeId: parentAgent.currentModeId,
        isUnattended: isParentInUnattendedMode(parentAgent.provider, parentAgent.currentModeId),
      },
      availableModes: getAvailableModeIds(provider),
      targetUnattendedMode: getUnattendedModeId(provider),
    });
    return {
      provider,
      initialPrompt: callerArgs.initialPrompt,
      background: callerArgs.background ?? false,
      normalizedTitle: callerArgs.title.trim(),
      model: resolvedProviderModel.model,
      thinking: callerArgs.thinking,
      labels: callerArgs.labels,
      notifyOnFinish: callerArgs.notifyOnFinish ?? false,
      resolvedCwd,
      resolvedMode,
      setupContinuation: undefined,
    };
  };

  const resolveTopLevelCreateAgentArgs = async (
    args: unknown,
  ): Promise<ResolvedCreateAgentArgs> => {
    const topLevelArgs = topLevelCreateAgentArgsSchema.parse(args);
    const resolvedProviderModel = resolveRequiredProviderModel(topLevelArgs.provider);
    const { cwd, mode, worktreeName, baseBranch, refName, action, githubPrNumber } = topLevelArgs;
    const resolvedMode = resolveAndValidateCreateAgentMode({
      requestedMode: mode,
      targetProvider: resolvedProviderModel.provider,
      parent: null,
      availableModes: getAvailableModeIds(resolvedProviderModel.provider),
      targetUnattendedMode: getUnattendedModeId(resolvedProviderModel.provider),
    });
    let resolvedCwd = expandUserPath(cwd);
    let setupContinuation: AgentWorktreeSetupContinuation | undefined;

    const shouldCreateWorktree = Boolean(worktreeName || refName || action || githubPrNumber);
    if (shouldCreateWorktree) {
      if (worktreeName && !baseBranch && !refName && !action && githubPrNumber === undefined) {
        throw new Error("baseBranch is required when creating a worktree");
      }
      const createdWorktree = await createMcpWorktree({
        input: {
          cwd: resolvedCwd,
          worktreeSlug: worktreeName,
          refName,
          action,
          githubPrNumber,
          ...(topLevelArgs.initialPrompt
            ? { firstAgentContext: { prompt: topLevelArgs.initialPrompt } }
            : {}),
          runSetup: false,
          paseoHome: options.paseoHome,
        },
        createPaseoWorktree: options.createPaseoWorktree,
        resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
        setupContinuation: {
          kind: "agent",
          terminalManager: terminalManager ?? null,
          appendTimelineItem: ({ agentId, item }) =>
            appendTimelineItemIfAgentKnown({
              agentManager,
              agentId,
              item,
            }),
          emitLiveTimelineItem: ({ agentId, item }) =>
            emitLiveTimelineItemIfAgentKnown({
              agentManager,
              agentId,
              item,
            }),
          logger: childLogger,
        },
      });
      resolvedCwd = createdWorktree.worktree.worktreePath;
      setupContinuation = createdWorktree.setupContinuation;
    }

    return {
      provider: resolvedProviderModel.provider,
      initialPrompt: topLevelArgs.initialPrompt,
      background: topLevelArgs.background ?? false,
      normalizedTitle: topLevelArgs.title.trim(),
      model: resolvedProviderModel.model,
      thinking: topLevelArgs.thinking,
      labels: topLevelArgs.labels,
      notifyOnFinish: topLevelArgs.notifyOnFinish ?? false,
      resolvedCwd,
      resolvedMode,
      setupContinuation,
    };
  };

  server.registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent tied to a working directory. Requires provider/model, for example codex/gpt-5.4. Do not guess; call list_providers and list_models first if uncertain. Optionally run an initial prompt immediately or create a git worktree for the agent.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string().nullable().optional(),
          }),
        ),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async (args: unknown) => {
      const resolved = callerAgentId
        ? resolveCallerCreateAgentArgs(args, callerAgentId)
        : await resolveTopLevelCreateAgentArgs(args);
      const {
        provider,
        initialPrompt,
        background,
        normalizedTitle,
        model,
        thinking,
        labels,
        notifyOnFinish,
        resolvedCwd,
        resolvedMode,
        setupContinuation,
      } = resolved;

      const childAgentDefaultLabels = callerContext?.childAgentDefaultLabels;
      const mergedLabels = {
        ...(callerAgentId ? { [PARENT_AGENT_ID_LABEL]: callerAgentId } : {}),
        ...childAgentDefaultLabels,
        ...labels,
      };
      const snapshot = await agentManager.createAgent(
        {
          provider,
          cwd: resolvedCwd,
          modeId: resolvedMode,
          title: normalizedTitle ?? undefined,
          model,
          thinkingOptionId: thinking,
        },
        undefined,
        Object.keys(mergedLabels).length > 0 ? { labels: mergedLabels } : undefined,
      );

      setupContinuation?.startAfterAgentCreate({
        agentId: snapshot.id,
      });

      const trimmedPrompt = initialPrompt.trim();
      scheduleAgentMetadataGeneration({
        agentManager,
        agentId: snapshot.id,
        cwd: snapshot.cwd,
        workspaceGitService: options.workspaceGitService,
        initialPrompt: trimmedPrompt,
        explicitTitle: snapshot.config.title,
        paseoHome: options.paseoHome,
        logger: childLogger,
      });

      try {
        agentManager.recordUserMessage(snapshot.id, trimmedPrompt, {
          emitState: false,
        });
      } catch (error) {
        childLogger.error({ err: error, agentId: snapshot.id }, "Failed to record initial prompt");
      }

      try {
        startAgentRun(agentManager, snapshot.id, trimmedPrompt, childLogger);
        if (notifyOnFinish && callerAgentId) {
          setupFinishNotification({
            agentManager,
            agentStorage,
            childAgentId: snapshot.id,
            callerAgentId,
            logger: childLogger,
          });
        }

        // If not running in background, wait for completion
        if (!background) {
          const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
            waitForActive: true,
          });

          const responseData = {
            agentId: snapshot.id,
            type: provider,
            status: result.status,
            cwd: snapshot.cwd,
            currentModeId: snapshot.currentModeId,
            availableModes: snapshot.availableModes,
            lastMessage: result.lastMessage,
            permission: sanitizePermissionRequest(result.permission),
          };
          const validJson = ensureValidJson(responseData);

          const response = {
            content: [],
            structuredContent: validJson,
          };
          return response;
        }
      } catch (error) {
        childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
      }

      // Return immediately if background=true
      const response = {
        content: [],
        structuredContent: ensureValidJson({
          agentId: snapshot.id,
          type: provider,
          status: snapshot.lifecycle,
          cwd: snapshot.cwd,
          currentModeId: snapshot.currentModeId,
          availableModes: snapshot.availableModes,
          lastMessage: null,
          permission: null,
        }),
      };
      return response;
    },
  );

  server.registerTool(
    "wait_for_agent",
    {
      title: "Wait for agent",
      description:
        "Block until the agent requests permission or the current run completes. Returns the pending permission (if any) and recent activity summary.",
      inputSchema: {
        agentId: z.string().describe("Agent identifier returned by the create_agent tool"),
      },
      outputSchema: {
        agentId: z.string(),
        status: AgentStatusEnum,
        permission: AgentPermissionRequestPayloadSchema.nullable(),
        lastMessage: z.string().nullable(),
      },
    },
    async ({ agentId }, { signal }) => {
      const abortController = new AbortController();
      const cleanupFns: Array<() => void> = [];

      const cleanup = () => {
        while (cleanupFns.length) {
          const fn = cleanupFns.pop();
          try {
            fn?.();
          } catch {
            // ignore cleanup errors
          }
        }
      };

      const forwardExternalAbort = () => {
        if (!abortController.signal.aborted) {
          const reason = signal?.reason ?? new Error("wait_for_agent aborted");
          abortController.abort(reason);
        }
      };

      if (signal) {
        if (signal.aborted) {
          forwardExternalAbort();
        } else {
          signal.addEventListener("abort", forwardExternalAbort, { once: true });
          cleanupFns.push(() => signal.removeEventListener("abort", forwardExternalAbort));
        }
      }

      const unregister = waitTracker.register(agentId, (reason) => {
        if (!abortController.signal.aborted) {
          abortController.abort(new Error(reason ?? "wait_for_agent cancelled"));
        }
      });
      cleanupFns.push(unregister);

      try {
        const result: WaitForAgentResult = await waitForAgentWithTimeout(agentManager, agentId, {
          signal: abortController.signal,
        });

        const validJson = ensureValidJson({
          agentId,
          status: result.status,
          permission: sanitizePermissionRequest(result.permission),
          lastMessage: result.lastMessage,
        });

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      } finally {
        cleanup();
      }
    },
  );

  server.registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Returns immediately after the agent begins processing.",
      inputSchema: {
        agentId: z.string(),
        prompt: z.string(),
        sessionMode: z
          .string()
          .optional()
          .describe("Optional mode to set before running the prompt."),
        background: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
          ),
        notifyOnFinish: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Send a notification prompt to the caller agent when this agent finishes, errors, or needs permission.",
          ),
      },
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
      },
    },
    async ({ agentId, prompt, sessionMode, background = false, notifyOnFinish = false }) => {
      if (agentManager.hasInFlightRun(agentId)) {
        waitTracker.cancel(agentId, "Agent run interrupted by new prompt");
      }

      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        userMessageText: prompt,
        prompt,
        sessionMode,
        logger: childLogger,
      });

      if (notifyOnFinish && callerAgentId) {
        setupFinishNotification({
          agentManager,
          agentStorage,
          childAgentId: agentId,
          callerAgentId,
          logger: childLogger,
        });
      }

      // If not running in background, wait for completion
      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }

      // Return immediately if background=true
      // Re-fetch snapshot since the state may have changed
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
    },
  );

  server.registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        const structuredSnapshot = await serializeSnapshotWithMetadata(
          agentStorage,
          snapshot,
          childLogger,
        );
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = buildStoredAgentPayload(
        record,
        resolveRegisteredProviderIds(agentManager, providerRegistry),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
        }),
      };
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents as compact metadata.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async ({ includeArchived = false, cwd, sinceHours = 48, statuses, limit = 50 }) => {
      const callerCwd = callerAgentId ? resolveCallerAgent()?.cwd : undefined;
      const requestedCwd = cwd?.trim() ? expandUserPath(cwd) : callerCwd;
      const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const liveSnapshots = agentManager.listAgents();
      const liveAgents = await Promise.all(
        liveSnapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger),
        ),
      );
      const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
      const storedRecords = await agentStorage.list();
      const registeredProviderIds = resolveRegisteredProviderIds(agentManager, providerRegistry);
      const storedAgents = storedRecords
        .filter((record) => !record.internal && !liveIds.has(record.id))
        .filter((record) => includeArchived || !record.archivedAt)
        .filter(
          (record) =>
            includeArchived || isStoredAgentProviderAvailable(record, registeredProviderIds),
        )
        .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
      const agents = [...liveAgents, ...storedAgents]
        .map(toAgentListItemPayload)
        .filter((agent) => !requestedCwd || isSameOrDescendantPath(requestedCwd, agent.cwd))
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !agent.archivedAt || resolveAgentListActivityTime(agent) >= sinceMs)
        .sort(compareAgentListItems)
        .slice(0, limit);

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  server.registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      const success = await agentManager.cancelAgentRun(agentId);
      if (success) {
        waitTracker.cancel(agentId, "Agent run cancelled");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ success }),
      };
    },
  );

  server.registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await agentManager.archiveAgent(agentId);
      waitTracker.cancel(agentId, "Agent archived");
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await agentManager.closeAgent(agentId);
      waitTracker.cancel(agentId, "Agent terminated");
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name and/or labels.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels }) => {
      const trimmedName = name?.trim();
      if (trimmedName) {
        const record = await agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent ${agentId} not found`);
        }
        await agentStorage.upsert({
          ...record,
          title: trimmedName,
          updatedAt: new Date().toISOString(),
        });
        agentManager.notifyAgentState(agentId);
      }

      if (labels) {
        await agentManager.setLabels(agentId, labels);
      }

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to the caller agent cwd."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  server.registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: "Create a terminal session for a working directory.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to the caller agent cwd."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = await terminalManager.createTerminal({
        cwd: resolveScopedCwd(cwd, { required: true }),
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  server.registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      if (!terminalManager.getTerminal(terminalId)) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  server.registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description: "Send literal text or special key tokens to a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken(keys, literal),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that runs on an agent or a new agent.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        every: z.string().optional(),
        cron: z.string().optional(),
        name: z.string().optional(),
        target: z.enum(["self", "new-agent"]).optional(),
        provider: AgentProviderEnum.optional().describe(
          "Provider, or provider/model (for example: codex or codex/gpt-5.4).",
        ),
        cwd: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, every, cron, name, target, provider, cwd, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const cadenceCount = Number(every !== undefined) + Number(cron !== undefined);
      if (cadenceCount !== 1) {
        throw new Error("Specify exactly one of every or cron");
      }

      const scheduleTarget =
        target === "self"
          ? (() => {
              const callerAgent = resolveCallerAgent();
              if (!callerAgentId || !callerAgent) {
                throw new Error("target=self requires a caller agent");
              }
              const trimmedCwd = cwd?.trim();
              if (trimmedCwd && expandUserPath(trimmedCwd) !== callerAgent.cwd) {
                throw new Error("cwd can only differ from the caller agent when target=new-agent");
              }
              if (provider !== undefined) {
                const resolved = resolveScheduleProviderAndModel({
                  provider,
                  defaultProvider: callerAgent.provider,
                });
                if (
                  resolved.provider !== callerAgent.provider ||
                  (resolved.model !== undefined && resolved.model !== callerAgent.config.model)
                ) {
                  throw new Error(
                    "provider can only differ from the caller agent when target=new-agent",
                  );
                }
              }
              return { type: "agent" as const, agentId: callerAgentId };
            })()
          : (() => {
              return resolveNewAgentScheduleTarget({ provider, cwd });
            })();

      const schedule = await scheduleService.create({
        prompt: prompt.trim(),
        cadence: every
          ? { type: "every" as const, everyMs: parseDurationString(every) }
          : { type: "cron" as const, expression: cron!.trim() },
        target: scheduleTarget,
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresIn === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + parseDurationString(expiresIn)).toISOString() }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  server.registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list()).map((schedule) =>
        toScheduleSummary(schedule),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  server.registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await scheduleService.inspect(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  server.registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = await Promise.all(
        Object.values(providerRegistry ?? {}).map((provider) =>
          resolveProviderSummary(provider, childLogger),
        ),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider }) => {
      if (!providerRegistry) {
        throw new Error("Provider registry is not configured");
      }

      const definition = providerRegistry[provider];
      if (!definition) {
        throw new Error(`Provider ${provider} is not configured`);
      }
      if (!definition.enabled) {
        throw new Error(`Provider '${provider}' is disabled`);
      }

      const models = await definition.fetchModels({ cwd: resolveSnapshotCwd(), force: false });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  server.registerTool(
    "list_worktrees",
    {
      title: "List worktrees",
      description: "List Paseo-managed git worktrees for a repository.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional repository cwd. Defaults to the caller agent cwd."),
      },
      outputSchema: {
        worktrees: z.array(WorktreeSummarySchema),
      },
    },
    async ({ cwd }) => {
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      if (!options.workspaceGitService) {
        throw new Error("WorkspaceGitService is required to list worktrees");
      }
      const worktrees = await options.workspaceGitService.listWorktrees(resolvedCwd, {
        reason: "mcp:list-worktrees",
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ worktrees }),
      };
    },
  );

  server.registerTool(
    "create_worktree",
    {
      title: "Create worktree",
      description:
        "Create a Paseo-managed git worktree. Branch off a new branch, check out an existing branch, or check out a GitHub PR.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository directory. Defaults to the agent's cwd."),
        target: z
          .discriminatedUnion("mode", [
            z
              .object({
                mode: z.literal("branch-off"),
                newBranch: z.string().min(1).describe("Name for the new branch."),
                base: z
                  .string()
                  .min(1)
                  .optional()
                  .describe("Base ref. Defaults to the repo's default branch."),
              })
              .describe("Create a new branch off a base."),
            z
              .object({
                mode: z.literal("checkout-branch"),
                branch: z.string().min(1).describe("Existing branch to check out."),
              })
              .describe("Check out an existing branch."),
            z
              .object({
                mode: z.literal("checkout-pr"),
                prNumber: z.number().int().positive().describe("Pull request number."),
              })
              .describe("Check out a GitHub pull request."),
          ])
          .describe("What the worktree should contain."),
      },
      outputSchema: {
        branchName: z.string(),
        worktreePath: z.string(),
      },
    },
    async ({ cwd, target }) => {
      const repoRoot = resolveScopedCwd(cwd, { required: true });
      const mcpInput = mcpCreateWorktreeInput(repoRoot, target, options.paseoHome);
      const createdWorktree = await createMcpWorktree({
        input: mcpInput.input,
        createPaseoWorktree: options.createPaseoWorktree,
        resolveDefaultBranch: mcpInput.resolveDefaultBranch,
      });
      const { worktree } = createdWorktree;

      return {
        content: [],
        structuredContent: ensureValidJson({
          branchName: worktree.branchName,
          worktreePath: worktree.worktreePath,
        }),
      };
    },
  );

  server.registerTool(
    "archive_worktree",
    {
      title: "Archive worktree",
      description: "Delete a Paseo-managed git worktree.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional repository cwd. Defaults to the caller agent cwd."),
        worktreePath: z.string().optional(),
        worktreeSlug: z.string().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ cwd, worktreePath, worktreeSlug }) => {
      const repoRoot = resolveScopedCwd(cwd, { required: true });
      if (!worktreePath && !worktreeSlug) {
        throw new Error("worktreePath or worktreeSlug is required");
      }
      if (!options.github) {
        throw new Error("GitHub service is required to archive worktrees");
      }
      if (!options.workspaceGitService) {
        throw new Error("WorkspaceGitService is required to archive worktrees");
      }
      if (!options.archiveWorkspaceRecord) {
        throw new Error("Workspace registry archiver is required to archive worktrees");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to archive worktrees");
      }
      if (!options.markWorkspaceArchiving) {
        throw new Error("Workspace archiving marker is required to archive worktrees");
      }
      if (!options.clearWorkspaceArchiving) {
        throw new Error("Workspace archiving clearer is required to archive worktrees");
      }
      if (!options.emitSessionMessage) {
        throw new Error("Session message emitter is required to archive worktrees");
      }

      const targetPath =
        worktreePath ??
        join(await getPaseoWorktreesRoot(repoRoot, options.paseoHome), worktreeSlug!);

      await archivePaseoWorktree(
        {
          paseoHome: options.paseoHome,
          github: options.github,
          workspaceGitService: options.workspaceGitService,
          agentManager,
          agentStorage,
          archiveWorkspaceRecord: options.archiveWorkspaceRecord,
          emit: options.emitSessionMessage,
          emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
          markWorkspaceArchiving: options.markWorkspaceArchiving,
          clearWorkspaceArchiving: options.clearWorkspaceArchiving,
          isPathWithinRoot: isSameOrDescendantPath,
          killTerminalsUnderPath: (rootPath) =>
            killTerminalsUnderPath(
              {
                terminalManager: terminalManager ?? null,
                isPathWithinRoot: isSameOrDescendantPath,
                killTrackedTerminal: () => {},
                sessionLogger: childLogger,
              },
              rootPath,
            ),
          sessionLogger: childLogger,
        },
        {
          targetPath,
          repoRoot,
          requestId: "mcp:archive_worktree",
        },
      );

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  server.registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      const selection = selectItemsByProjectedLimit({
        items: timeline,
        direction: "tail",
        limit: limit ?? 0,
      });
      const curatedContent = curateAgentActivity(selection.items);
      const { totalProjected, shownProjected } = selection;

      const noun = totalProjected === 1 ? "activity" : "activities";
      const countHeader =
        limit && shownProjected < totalProjected
          ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${limit})`
          : `Showing all ${totalProjected} ${noun}`;

      const contentWithCount = `${countHeader}\n\n${curatedContent}`;

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: contentWithCount,
        }),
      };
    },
  );

  server.registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      await agentManager.setAgentMode(agentId, modeId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: modeId }),
      };
    },
  );

  server.registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request,
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  server.registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await agentManager.respondToPermission(agentId, requestId, response);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  return server;
}

type McpCreateWorktreeTarget =
  | { mode: "branch-off"; newBranch: string; base?: string }
  | { mode: "checkout-branch"; branch: string }
  | { mode: "checkout-pr"; prNumber: number };

function mcpCreateWorktreeInput(
  repoRoot: string,
  target: McpCreateWorktreeTarget,
  paseoHome: string | undefined,
): { input: CreatePaseoWorktreeInput; resolveDefaultBranch?: (root: string) => Promise<string> } {
  const base = { cwd: repoRoot, runSetup: false, paseoHome } as const;
  switch (target.mode) {
    case "branch-off":
      return {
        input: {
          ...base,
          worktreeSlug: target.newBranch,
          action: "branch-off",
          ...(target.base ? { refName: target.base } : {}),
        },
      };
    case "checkout-branch":
      return {
        input: { ...base, action: "checkout", refName: target.branch },
      };
    case "checkout-pr":
      return {
        input: { ...base, action: "checkout", githubPrNumber: target.prNumber },
      };
    default:
      throw new Error("unreachable");
  }
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
    const result = await options.createPaseoWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
    return result;
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}
