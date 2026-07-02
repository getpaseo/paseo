import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type FetchCatalogOptions,
  type ProviderCatalog,
} from "../../agent-sdk-types.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";
import {
  PASEO_AGENT_PROVIDER,
  type PaseoAgentConfig,
  listPaseoAgentModels,
  paseoAgentHasUsableModel,
  paseoAgentModelProviders,
  parsePaseoAgentModelId,
  resolvePaseoAgentModel,
} from "./config.js";
import {
  convertPromptInput,
  getUserMessageText,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  toAgentUsage,
  type PiTrackedToolCall,
} from "./event-mapping.js";
import { createMcpToolBridge, type McpToolBridge } from "./mcp-bridge.js";
import {
  createBoundPaseoAgentAuthStorage,
  hasStoredOAuthCredential,
  type OAuthCredentialBinding,
} from "./oauth-store.js";
import { createPaseoAgentSession, type PaseoAgentSessionHandle } from "./pi-services.js";
import { createToolPermissionPolicy } from "./agent-permissions.js";
import {
  composePromptParts,
  listAgentDefinitionIds,
  loadAgentDefinition,
  type ResolvedAgentDefinition,
} from "./prompt-profiles.js";

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const PASEO_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  // Phase 4 uses in-memory sessions; resume/persistence is out of scope.
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  // MCP servers from AgentSessionConfig.mcpServers are bridged to Pi custom tools.
  supportsMcpServers: true,
  requiresPaseoTools: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  return value && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : null;
}

function resolveIsolatedAgentDir(): string {
  // Paseo-owned, never ~/.pi. Inert because all Pi services are in-memory, but we
  // still keep it off the project tree and outside Pi's default global config.
  const base = process.env.PASEO_HOME ?? join(tmpdir(), "paseo-agent");
  return join(base, "pi-harness");
}

function envForPaseoHome(paseoHome: string | undefined): NodeJS.ProcessEnv {
  return paseoHome ? { ...process.env, PASEO_HOME: paseoHome } : process.env;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return /\brequest was aborted\b|\babort(ed)?\b/i.test(errorToMessage(error));
}

function oauthCredentialBindings(
  providers: Awaited<ReturnType<typeof paseoAgentModelProviders>>,
): Record<string, OAuthCredentialBinding> {
  const bindings: Record<string, OAuthCredentialBinding> = {};
  for (const provider of providers) {
    if (provider.oauth) {
      bindings[provider.name] = {
        flow: provider.oauth.flow,
        baseUrl: provider.config.baseUrl ?? "",
      };
    }
  }
  return bindings;
}

interface PaseoAgentClientOptions {
  logger: Logger;
  config: PaseoAgentConfig;
  paseoHome?: string;
}

export class PaseoAgentSession implements AgentSession {
  readonly provider = PASEO_AGENT_PROVIDER;
  readonly capabilities = PASEO_AGENT_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private activeTurnId: string | null = null;
  private lastThinkingOptionId: string | null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly handle: PaseoAgentSessionHandle,
    private readonly config: AgentSessionConfig,
    private readonly mcpBridge: McpToolBridge,
    private readonly agentId: string | null,
    private readonly availableAgents: AgentMode[],
  ) {
    this.lastThinkingOptionId =
      normalizeThinkingLevel(config.thinkingOptionId) ?? this.piSession.thinkingLevel ?? null;
    this.piSession.subscribe((event) => this.handleSessionEvent(event));
  }

  private get piSession() {
    return this.handle.session;
  }

  get id(): string | null {
    return this.piSession.sessionId;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private clearActiveTurn(): string | null {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.activeToolCalls.clear();
    return turnId;
  }

  private emitActiveTurnCanceled(reason: string): boolean {
    const turnId = this.clearActiveTurn();
    if (!turnId) {
      return false;
    }
    this.emit({
      type: "turn_canceled",
      provider: PASEO_AGENT_PROVIDER,
      turnId,
      reason,
    });
    return true;
  }

  private emitToolCall(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    status: "running" | "completed" | "failed",
    result: ReturnType<typeof parseToolResult>,
    error: unknown,
  ): void {
    const turnId = this.activeTurnId ?? undefined;
    const baseItem = {
      type: "tool_call" as const,
      callId: toolCallId,
      name: toolCall.toolName,
      detail: mapToolDetail(toolCall, result),
    };
    const item =
      status === "failed" ? { ...baseItem, status, error } : { ...baseItem, status, error: null };
    this.emit({ type: "timeline", provider: PASEO_AGENT_PROVIDER, turnId, item });
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const turnId = this.activeTurnId ?? undefined;
    switch (event.type) {
      case "agent_start":
        this.emit({
          type: "thread_started",
          provider: PASEO_AGENT_PROVIDER,
          sessionId: this.piSession.sessionId,
        });
        return;
      case "turn_start":
        this.emit({ type: "turn_started", provider: PASEO_AGENT_PROVIDER, turnId });
        return;
      case "message_update":
        this.handleMessageUpdate(event, turnId);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.emitToolCall(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }
        this.emitToolCall(
          event.toolCallId,
          toolCall,
          "running",
          parseToolResult(event.partialResult),
          null,
        );
        return;
      }
      case "tool_execution_end": {
        const toolCall =
          this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
        this.activeToolCalls.delete(event.toolCallId);
        const result = parseToolResult(event.result);
        const status = event.isError ? "failed" : "completed";
        this.emitToolCall(
          event.toolCallId,
          toolCall,
          status,
          result,
          event.isError ? event.result : null,
        );
        return;
      }
      case "agent_end":
        this.handleAgentEnd(event);
        return;
      default:
        return;
    }
  }

  private handleMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      this.emit({
        type: "timeline",
        provider: PASEO_AGENT_PROVIDER,
        turnId,
        item: { type: "assistant_message", text: event.assistantMessageEvent.delta ?? "" },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      this.emit({
        type: "timeline",
        provider: PASEO_AGENT_PROVIDER,
        turnId,
        item: { type: "reasoning", text: event.assistantMessageEvent.delta ?? "" },
      });
    }
  }

  private handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
    if (event.willRetry) {
      return;
    }
    const usage = toAgentUsage(this.piSession.getSessionStats());
    const currentTurnId = this.clearActiveTurn() ?? undefined;
    if (!currentTurnId) {
      return;
    }
    const errorMessage = this.piSession.agent.state.errorMessage;
    if (errorMessage) {
      this.emit({
        type: "turn_failed",
        provider: PASEO_AGENT_PROVIDER,
        turnId: currentTurnId,
        error: errorMessage,
      });
      return;
    }
    this.emit({
      type: "turn_completed",
      provider: PASEO_AGENT_PROVIDER,
      turnId: currentTurnId,
      usage,
    });
  }

  private emitSubmittedUserMessage(text: string, messageId: string, turnId: string): void {
    if (text.trim().length === 0) {
      return;
    }
    this.emit({
      type: "timeline",
      provider: PASEO_AGENT_PROVIDER,
      turnId,
      item: { type: "user_message", text, messageId },
    });
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.piSession.sessionId,
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A Paseo Agent turn is already active");
    }
    const payload = convertPromptInput(prompt);
    const turnId = randomUUID();
    const messageId = options?.messageId ?? randomUUID();
    this.activeTurnId = turnId;
    this.emitSubmittedUserMessage(payload.text, messageId, turnId);

    void this.piSession
      .prompt(payload.text, payload.images ? { images: payload.images } : undefined)
      .catch((error: unknown) => {
        if (this.activeTurnId !== turnId) {
          return;
        }
        if (isAbortError(error)) {
          this.emitActiveTurnCanceled(errorToMessage(error));
          return;
        }
        const failedTurnId = this.clearActiveTurn() ?? turnId;
        this.emit({
          type: "turn_failed",
          provider: PASEO_AGENT_PROVIDER,
          turnId: failedTurnId,
          error: errorToMessage(error),
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const pendingToolCalls = new Map<string, PiTrackedToolCall>();
    let userIndex = 0;

    for (const message of this.piSession.messages) {
      if (message.role === "user") {
        const text = getUserMessageText(message.content);
        if (text) {
          yield {
            type: "timeline",
            provider: PASEO_AGENT_PROVIDER,
            item: { type: "user_message", text, messageId: `paseo-agent-user-${userIndex}` },
          };
        }
        userIndex += 1;
        continue;
      }
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type === "text" && content.text) {
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: { type: "assistant_message", text: content.text },
            };
            continue;
          }
          if (content.type === "thinking" && content.thinking) {
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: { type: "reasoning", text: content.thinking },
            };
            continue;
          }
          if (content.type === "toolCall") {
            const tracked = parseToolArgs(content.name, content.arguments);
            pendingToolCalls.set(content.id, tracked);
            yield {
              type: "timeline",
              provider: PASEO_AGENT_PROVIDER,
              item: {
                type: "tool_call",
                callId: content.id,
                name: tracked.toolName,
                status: "running",
                detail: mapToolDetail(tracked, null),
                error: null,
              },
            };
          }
        }
        continue;
      }
      if (message.role === "toolResult") {
        const tracked =
          pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
        pendingToolCalls.delete(message.toolCallId);
        const detail = mapToolDetail(tracked, parseToolResult({ content: message.content }));
        const base = {
          type: "tool_call" as const,
          callId: message.toolCallId,
          name: tracked.toolName,
          detail,
        };
        yield {
          type: "timeline",
          provider: PASEO_AGENT_PROVIDER,
          item: message.isError
            ? { ...base, status: "failed", error: "Tool call failed" }
            : { ...base, status: "completed", error: null },
        };
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const model = this.piSession.model;
    return {
      provider: PASEO_AGENT_PROVIDER,
      sessionId: this.piSession.sessionId,
      model: model ? `${model.provider}/${model.id}` : null,
      thinkingOptionId:
        normalizeThinkingLevel(this.lastThinkingOptionId) ?? this.piSession.thinkingLevel ?? null,
      modeId: this.agentId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return this.availableAgents;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.agentId;
  }

  async setMode(modeId: string): Promise<void> {
    if (modeId === this.agentId) {
      return;
    }
    throw new Error("Paseo Agent selection is fixed when the session starts");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }

  async interrupt(): Promise<void> {
    const canceled = this.emitActiveTurnCanceled("interrupted");
    try {
      await this.piSession.abort();
    } catch (error) {
      if (!canceled || !isAbortError(error)) {
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        if (this.activeTurnId) {
          await this.interrupt();
        }
      } finally {
        this.piSession.dispose();
        await this.mcpBridge.close();
      }
    })();
    await this.closePromise;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!modelId) {
      return;
    }
    const reference = parsePaseoAgentModelId(modelId);
    if (!reference) {
      throw new Error(`Invalid Paseo Agent model: ${modelId}`);
    }
    const model = this.handle.modelRegistry.find(reference.provider, reference.id);
    if (!model) {
      throw new Error(`Unknown Paseo Agent model: ${modelId}`);
    }
    await this.piSession.setModel(model);
    this.config.model = modelId;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const level = normalizeThinkingLevel(thinkingOptionId) ?? DEFAULT_THINKING_LEVEL;
    this.piSession.setThinkingLevel(level);
    this.lastThinkingOptionId = level;
    this.config.thinkingOptionId = level;
  }
}

export class PaseoAgentClient implements AgentClient {
  readonly provider = PASEO_AGENT_PROVIDER;
  readonly capabilities = PASEO_AGENT_CAPABILITIES;

  private readonly logger: Logger;
  private readonly config: PaseoAgentConfig;
  private readonly paseoHome: string | undefined;

  constructor(options: PaseoAgentClientOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.paseoHome = options.paseoHome;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const modelProviders = await paseoAgentModelProviders(this.config);
    if (modelProviders.length === 0) {
      throw new Error(
        "Paseo Agent has no configured model providers. Add agents.paseo.providers to your Paseo config.",
      );
    }

    const availableAgents = this.loadAvailableAgentModes();
    const agent = this.loadSelectedAgent(config.modeId);
    this.verifyExpectedMcpServers(agent, config.mcpServers);
    const model = resolvePaseoAgentModel(this.config, config.model, modelProviders, agent?.model);
    const thinkingLevel = normalizeThinkingLevel(config.thinkingOptionId) ?? undefined;
    const composedPrompt = composePromptParts({
      agent,
      systemPrompt: config.systemPrompt,
      daemonAppendSystemPrompt: config.daemonAppendSystemPrompt,
    });
    this.logger.debug(
      {
        provider: PASEO_AGENT_PROVIDER,
        model: model ? `${model.provider}/${model.id}` : null,
        agent: agent?.id ?? null,
      },
      "Creating Paseo Agent session",
    );

    // Catalog OAuth providers use a Paseo-owned, file-backed AuthStorage so Pi reads
    // the stored credential and persists refreshed tokens (rotation) back to it.
    const usesOAuth = modelProviders.some((provider) => provider.oauth);
    const authStorage = usesOAuth
      ? createBoundPaseoAgentAuthStorage(
          oauthCredentialBindings(modelProviders),
          envForPaseoHome(this.paseoHome),
        )
      : undefined;

    // Bridge Paseo-injected MCP servers (e.g. the `paseo` HTTP server) into Pi tools.
    const permissionPolicy = createToolPermissionPolicy(agent?.permissions);
    const mcpBridge = await createMcpToolBridge({
      mcpServers: config.mcpServers,
      logger: this.logger,
    });

    try {
      const handle = await createPaseoAgentSession({
        cwd: config.cwd,
        agentDir: resolveIsolatedAgentDir(),
        modelProviders,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(authStorage ? { authStorage } : {}),
        ...(mcpBridge.tools.length > 0 ? { customTools: mcpBridge.tools } : {}),
        ...(agent?.tools ? { tools: agent.tools } : {}),
        permissionPolicy,
        ...(composedPrompt ? { composedPrompt } : {}),
      });
      return new PaseoAgentSession(handle, config, mcpBridge, agent?.id ?? null, availableAgents);
    } catch (error) {
      await mcpBridge.close();
      throw error;
    }
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error("Paseo Agent does not support session resume in this prototype");
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    return {
      models: listPaseoAgentModels(this.config),
      modes: await this.loadAvailableAgentModes(),
    };
  }

  async isAvailable(): Promise<boolean> {
    const env = envForPaseoHome(this.paseoHome);
    return paseoAgentHasUsableModel(this.config, env, (providerInstance, binding) =>
      hasStoredOAuthCredential(providerInstance, env, binding),
    );
  }

  private loadSelectedAgent(requestedAgentId: string | undefined): ResolvedAgentDefinition | null {
    const selectedAgentId =
      requestedAgentId ?? this.config.defaultAgent ?? this.config.defaultProfile;
    if (!this.paseoHome || !selectedAgentId) {
      return null;
    }
    try {
      const agent = loadAgentDefinition(this.paseoHome, selectedAgentId);
      if (!agent) {
        this.logger.warn(
          { provider: PASEO_AGENT_PROVIDER, agent: selectedAgentId },
          "Configured Paseo Agent definition was not found",
        );
      }
      return agent;
    } catch (error) {
      this.logger.warn(
        {
          provider: PASEO_AGENT_PROVIDER,
          agent: selectedAgentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Configured Paseo Agent definition could not be loaded",
      );
      return null;
    }
  }

  private loadAvailableAgentModes(): AgentMode[] {
    const paseoHome = this.paseoHome;
    if (!paseoHome) {
      return [];
    }
    return listAgentDefinitionIds(paseoHome).flatMap((agentId): AgentMode[] => {
      try {
        const agent = loadAgentDefinition(paseoHome, agentId);
        if (!agent) {
          return [];
        }
        return [
          {
            id: agent.id,
            label: agent.frontmatter.name ?? agent.id,
            ...(agent.frontmatter.description
              ? { description: agent.frontmatter.description }
              : {}),
          },
        ];
      } catch (error) {
        this.logger.warn(
          {
            provider: PASEO_AGENT_PROVIDER,
            agent: agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Paseo Agent definition could not be listed",
        );
        return [];
      }
    });
  }

  private verifyExpectedMcpServers(
    agent: ResolvedAgentDefinition | null,
    configuredServers: AgentSessionConfig["mcpServers"],
  ): void {
    for (const serverName of new Set(agent?.expectedMcpServers ?? [])) {
      if (!configuredServers?.[serverName]) {
        this.logger.warn(
          {
            provider: PASEO_AGENT_PROVIDER,
            agent: agent?.id ?? null,
            mcpServer: serverName,
          },
          "Paseo Agent definition expects an MCP server that is not configured for this session",
        );
      }
    }
  }
}
