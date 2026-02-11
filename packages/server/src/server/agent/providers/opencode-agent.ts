import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import net from "node:net";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMetadata,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  McpServerConfig,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";
import {
  applyProviderEnv,
  isProviderCommandAvailable,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { mapOpencodeToolCall } from "./opencode/tool-call-mapper.js";

const OPENCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const DEFAULT_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Standard permission rules",
  },
];

type OpenCodeAgentConfig = AgentSessionConfig & { provider: "opencode" };

type OpenCodeMcpConfig =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    };

const MCP_ALREADY_PRESENT_ERROR_TOKENS = ["already", "exists", "connected"] as const;

function resolveOpenCodeBinary(): string {
  try {
    const opencodePath = execSync("which opencode", { encoding: "utf8" }).trim();
    if (opencodePath) {
      return opencodePath;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "OpenCode CLI not found. Please install opencode globally so Paseo can launch the provider."
  );
}

function toOpenCodeMcpConfig(config: McpServerConfig): OpenCodeMcpConfig {
  if (config.type === "stdio") {
    return {
      type: "local",
      command: [config.command, ...(config.args ?? [])],
      ...(config.env ? { environment: config.env } : {}),
      enabled: true,
    };
  }

  return {
    type: "remote",
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    enabled: true,
  };
}

function stringifyUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isAlreadyPresentMcpError(error: unknown): boolean {
  const normalized = stringifyUnknownError(error).toLowerCase();
  return MCP_ALREADY_PRESENT_ERROR_TOKENS.some((token) =>
    normalized.includes(token)
  );
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

export class OpenCodeServerManager {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private server: ChildProcess | null = null;
  private port: number | null = null;
  private startPromise: Promise<{ port: number; url: string }> | null = null;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;

  private constructor(logger: Logger, runtimeSettings?: ProviderRuntimeSettings) {
    this.logger = logger;
    this.runtimeSettings = runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(runtimeSettings ?? {});
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager(logger, runtimeSettings);
      OpenCodeServerManager.registerExitHandler();
    } else if (OpenCodeServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode server manager already initialized with different runtime settings"
      );
    }
    return OpenCodeServerManager.instance;
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      const instance = OpenCodeServerManager.instance;
      if (instance?.server && !instance.server.killed) {
        instance.server.kill("SIGTERM");
      }
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async ensureRunning(): Promise<{ port: number; url: string }> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.server && this.port && !this.server.killed) {
      return { port: this.port, url: `http://127.0.0.1:${this.port}` };
    }

    this.startPromise = this.startServer();
    try {
      const result = await this.startPromise;
      return result;
    } finally {
      this.startPromise = null;
    }
  }

  private async startServer(): Promise<{ port: number; url: string }> {
    this.port = await findAvailablePort();
    const url = `http://127.0.0.1:${this.port}`;
    const launchPrefix = resolveProviderCommandPrefix(
      this.runtimeSettings?.command,
      resolveOpenCodeBinary
    );

    return new Promise((resolve, reject) => {
      this.server = spawn(
        launchPrefix.command,
        [...launchPrefix.args, "serve", "--port", String(this.port)],
        {
        stdio: ["ignore", "pipe", "pipe"],
        env: applyProviderEnv(process.env, this.runtimeSettings),
      }
      );

      let started = false;
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error("OpenCode server startup timeout"));
        }
      }, 30_000);

      this.server.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        if (output.includes("listening on") && !started) {
          started = true;
          clearTimeout(timeout);
          resolve({ port: this.port!, url });
        }
      });

      this.server.stderr?.on("data", (data: Buffer) => {
        this.logger.error({ stderr: data.toString().trim() }, "OpenCode server stderr");
      });

      this.server.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.server.on("exit", (code) => {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`OpenCode server exited with code ${code}`));
        }
        this.server = null;
        this.port = null;
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.server && !this.server.killed) {
      this.server.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.server?.kill("SIGKILL");
          resolve();
        }, 5000);
        this.server?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.server = null;
    this.port = null;
  }
}

export class OpenCodeAgentClient implements AgentClient {
  readonly provider: "opencode" = "opencode";
  readonly capabilities = OPENCODE_CAPABILITIES;

  private readonly serverManager: OpenCodeServerManager;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;

  constructor(logger: Logger, runtimeSettings?: ProviderRuntimeSettings) {
    this.logger = logger.child({ module: "agent", provider: "opencode" });
    this.runtimeSettings = runtimeSettings;
    this.serverManager = OpenCodeServerManager.getInstance(
      this.logger,
      runtimeSettings
    );
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const openCodeConfig = this.assertConfig(config);
    const { url } = await this.serverManager.ensureRunning();
    const client = createOpencodeClient({
      baseUrl: url,
      directory: openCodeConfig.cwd,
    });

    // Set a timeout for session creation to fail fast
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OpenCode session.create timed out after 10s")), 10_000);
    });

    const response = await Promise.race([
      client.session.create({ directory: openCodeConfig.cwd }),
      timeoutPromise,
    ]);

    if (response.error) {
      throw new Error(`Failed to create OpenCode session: ${JSON.stringify(response.error)}`);
    }

    const session = response.data;
    if (!session) {
      throw new Error("OpenCode session creation returned no data");
    }

    return new OpenCodeAgentSession(openCodeConfig, client, session.id);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? (handle.metadata?.cwd as string);
    if (!cwd) {
      throw new Error("OpenCode resume requires the original working directory");
    }

    const config: AgentSessionConfig = {
      provider: "opencode",
      cwd,
      ...overrides,
    };
    const openCodeConfig = this.assertConfig(config);
    const { url } = await this.serverManager.ensureRunning();
    const client = createOpencodeClient({
      baseUrl: url,
      directory: openCodeConfig.cwd,
    });

    return new OpenCodeAgentSession(openCodeConfig, client, handle.sessionId);
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const { url } = await this.serverManager.ensureRunning();
    const client = createOpencodeClient({
      baseUrl: url,
      directory: options?.cwd ?? process.cwd(),
    });

    // Set a timeout for the API call to fail fast if OpenCode isn't responding
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OpenCode provider.list timed out after 10s - server may not be authenticated or connected to any providers")), 10_000);
    });

    const response = await Promise.race([
      client.provider.list({ directory: options?.cwd ?? process.cwd() }),
      timeoutPromise,
    ]);

    if (response.error) {
      throw new Error(`Failed to fetch OpenCode providers: ${JSON.stringify(response.error)}`);
    }

    const providers = response.data;
    if (!providers) {
      return [];
    }

    // Only include models from connected providers (ones that are actually available)
    const connectedProviderIds = new Set(providers.connected);

    // Fail fast if no providers are connected
    if (connectedProviderIds.size === 0) {
      throw new Error("OpenCode has no connected providers. Please authenticate with at least one provider (e.g., openai, anthropic) or set appropriate environment variables (e.g., OPENAI_API_KEY).");
    }

    const models: AgentModelDefinition[] = [];
    for (const provider of providers.all) {
      // Skip providers that aren't connected/configured
      if (!connectedProviderIds.has(provider.id)) {
        continue;
      }

      for (const [modelId, model] of Object.entries(provider.models)) {
        const rawVariants = model.variants ? Object.keys(model.variants) : [];
        const thinkingOptions = [
          { id: "default", label: "Model default", isDefault: true },
          ...rawVariants.map((id) => ({ id, label: id })),
        ];

        models.push({
          provider: "opencode",
          id: `${provider.id}/${modelId}`,
          label: model.name,
          description: `${provider.name} - ${model.family ?? ""}`.trim(),
          thinkingOptions: thinkingOptions.length > 1 ? thinkingOptions : undefined,
          defaultThinkingOptionId: "default",
          metadata: {
            providerId: provider.id,
            providerName: provider.name,
            modelId,
            family: model.family,
            releaseDate: model.release_date,
            supportsAttachments: model.attachment,
            supportsReasoning: model.reasoning,
            supportsToolCall: model.tool_call,
            cost: model.cost,
          },
        });
      }
    }

    return models;
  }

  async listPersistedAgents(_options?: ListPersistedAgentsOptions): Promise<PersistedAgentDescriptor[]> {
    // TODO: Implement by listing sessions from OpenCode
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return isProviderCommandAvailable(
      this.runtimeSettings?.command,
      resolveOpenCodeBinary
    );
  }

  private assertConfig(config: AgentSessionConfig): OpenCodeAgentConfig {
    if (config.provider !== "opencode") {
      throw new Error(`OpenCodeAgentClient received config for provider '${config.provider}'`);
    }
    return { ...config, provider: "opencode" };
  }
}

class OpenCodeAgentSession implements AgentSession {
  readonly provider: "opencode" = "opencode";
  readonly capabilities = OPENCODE_CAPABILITIES;

  private readonly config: OpenCodeAgentConfig;
  private readonly client: OpencodeClient;
  private readonly sessionId: string;
  private currentMode: string = "default";
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private abortController: AbortController | null = null;
  private accumulatedUsage: AgentUsage = {};
  private mcpConfigured = false;
  private mcpSetupPromise: Promise<void> | null = null;
  /** Tracks the role of each message by ID to distinguish user from assistant messages */
  private messageRoles = new Map<string, "user" | "assistant">();

  constructor(
    config: OpenCodeAgentConfig,
    client: OpencodeClient,
    sessionId: string
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = sessionId;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: "opencode",
      sessionId: this.sessionId,
      model: this.config.model ?? null,
      modeId: this.currentMode,
    };
  }

  async setModel(modelId: string | null): Promise<void> {
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;
    this.config.model = normalizedModelId ?? undefined;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;
    this.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
  }

  async run(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    const events = this.stream(prompt);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text;
        }
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      }
    }

    return {
      sessionId: this.sessionId,
      finalText,
      usage,
      timeline,
    };
  }

  async *stream(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    this.abortController = new AbortController();
    await this.ensureMcpServersConfigured();

    const parts = this.buildPromptParts(prompt);
    const model = this.parseModel(this.config.model);
    const thinkingOptionId = this.config.thinkingOptionId;
    const effectiveVariant =
      thinkingOptionId && thinkingOptionId !== "default" ? thinkingOptionId : undefined;

    // Send prompt asynchronously
    const promptResponse = await this.client.session.promptAsync({
      sessionID: this.sessionId,
      directory: this.config.cwd,
      parts,
      ...(this.config.systemPrompt ? { system: this.config.systemPrompt } : {}),
      ...(model ? { model } : {}),
      ...(effectiveVariant ? { variant: effectiveVariant } : {}),
    });

    if (promptResponse.error) {
      yield {
        type: "turn_failed",
        provider: "opencode",
        error: JSON.stringify(promptResponse.error),
      };
      return;
    }

    // Subscribe to events
    const eventsResult = await this.client.event.subscribe({
      directory: this.config.cwd,
    });

    try {
      for await (const event of eventsResult.stream) {
        if (this.abortController.signal.aborted) {
          break;
        }

        const translated = this.translateEvent(event);
        for (const e of translated) {
          yield e;
          if (e.type === "turn_completed" || e.type === "turn_failed") {
            return;
          }
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        yield {
          type: "turn_failed",
          provider: "opencode",
          error: error instanceof Error ? error.message : "Stream error",
        };
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    await this.client.session.abort({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const response = await this.client.session.messages({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });

    if (response.error || !response.data) {
      return;
    }

    const messages = response.data;

    for (const message of messages) {
      const { info, parts } = message;
      const role = info.role as "user" | "assistant";

      if (role === "user") {
        // Extract user message text from parts
        const textParts = parts.filter(
          (p) => (p as { type?: string }).type === "text"
        );
        const text = textParts
          .map((p) => (p as { text?: string }).text ?? "")
          .join("");

        if (text) {
          yield {
            type: "timeline",
            provider: "opencode",
            item: { type: "user_message", text },
          };
        }
      } else if (role === "assistant") {
        // Process each part
        for (const part of parts) {
          const partType = (part as { type?: string }).type;

          if (partType === "text") {
            const text = (part as { text?: string }).text;
            if (text) {
              yield {
                type: "timeline",
                provider: "opencode",
                item: { type: "assistant_message", text },
              };
            }
          } else if (partType === "reasoning") {
            const text = (part as { text?: string }).text;
            if (text) {
              yield {
                type: "timeline",
                provider: "opencode",
                item: { type: "reasoning", text },
              };
            }
          } else if (partType === "tool") {
            const toolPart = part as {
              id?: string;
              tool?: string;
              callID?: string;
              state?: {
                status?: string;
                input?: AgentMetadata;
                output?: string;
                error?: string;
              };
            };
            const toolName = toolPart.tool;
            const state = toolPart.state;

            if (toolName) {
              yield {
                type: "timeline",
                provider: "opencode",
                item: mapOpencodeToolCall({
                  toolName,
                  callId: toolPart.callID ?? toolPart.id,
                  status: state?.status,
                  input: state?.input,
                  output: state?.output,
                  error: state?.error,
                }),
              };
            }
          }
        }
      }
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return DEFAULT_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async setMode(modeId: string): Promise<void> {
    this.currentMode = modeId;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }

    const reply = response.behavior === "allow" ? "once" : "reject";
    await this.client.permission.reply({
      requestID: requestId,
      directory: this.config.cwd,
      reply,
      message: response.behavior === "deny" ? response.message : undefined,
    });

    this.pendingPermissions.delete(requestId);
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "opencode",
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        cwd: this.config.cwd,
      },
    };
  }

  async close(): Promise<void> {
    this.abortController?.abort();
  }

  private buildPromptParts(prompt: AgentPromptInput): Array<{ type: "text"; text: string }> {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt }];
    }
    return prompt
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => ({ type: "text", text: p.text }));
  }

  private parseModel(model?: string): { providerID: string; modelID: string } | undefined {
    if (!model) {
      return undefined;
    }
    const parts = model.split("/");
    if (parts.length >= 2) {
      return { providerID: parts[0], modelID: parts.slice(1).join("/") };
    }
    return { providerID: "opencode", modelID: model };
  }

  private async ensureMcpServersConfigured(): Promise<void> {
    if (this.mcpConfigured) {
      return;
    }

    const mcpServers = this.config.mcpServers;
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
      this.mcpConfigured = true;
      return;
    }

    if (!this.mcpSetupPromise) {
      this.mcpSetupPromise = this.configureMcpServers(mcpServers);
    }

    try {
      await this.mcpSetupPromise;
      this.mcpConfigured = true;
    } catch (error) {
      this.mcpSetupPromise = null;
      throw error;
    }
  }

  private async configureMcpServers(
    mcpServers: Record<string, McpServerConfig>
  ): Promise<void> {
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const mappedConfig = toOpenCodeMcpConfig(serverConfig);
      await this.registerMcpServer(name, mappedConfig);
    }
  }

  private async registerMcpServer(
    name: string,
    config: OpenCodeMcpConfig
  ): Promise<void> {
    await this.runMcpOperation("add", name, () =>
      this.client.mcp.add({
        directory: this.config.cwd,
        name,
        config,
      })
    );
    await this.runMcpOperation("connect", name, () =>
      this.client.mcp.connect({
        directory: this.config.cwd,
        name,
      })
    );
  }

  private async runMcpOperation(
    operation: "add" | "connect",
    name: string,
    run: () => Promise<{ error?: unknown }>
  ): Promise<void> {
    const response = await run();
    const error = response.error;
    if (!error) {
      return;
    }

    if (isAlreadyPresentMcpError(error)) {
      return;
    }

    throw new Error(
      `Failed to ${operation} OpenCode MCP server '${name}': ${stringifyUnknownError(error)}`
    );
  }

  private translateEvent(event: unknown): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    if (!event || typeof event !== "object") {
      return events;
    }

    const e = event as { type?: string; properties?: AgentMetadata };
    const type = e.type;
    const props = e.properties ?? {};

    switch (type) {
      case "session.created":
      case "session.updated": {
        const sessionId = props.id as string | undefined;
        if (sessionId === this.sessionId) {
          events.push({
            type: "thread_started",
            sessionId: this.sessionId,
            provider: "opencode",
          });
        }
        break;
      }

      case "message.updated": {
        // Track message roles by ID so we can distinguish user from assistant parts
        const info = props.info as AgentMetadata | undefined;
        if (!info) {
          break;
        }
        const messageId = info.id as string | undefined;
        const messageSessionId = info.sessionID as string | undefined;
        const role = info.role as "user" | "assistant" | undefined;

        if (messageId && messageSessionId === this.sessionId && role) {
          this.messageRoles.set(messageId, role);
        }
        break;
      }

      case "message.part.updated": {
        // Structure: { part: { id, sessionID, messageID, type, text?, ... }, delta?: string }
        const part = props.part as AgentMetadata | undefined;
        const delta = props.delta as string | undefined;
        if (!part) {
          break;
        }

        const partSessionId = part.sessionID as string | undefined;
        if (partSessionId !== this.sessionId) {
          break;
        }

        const messageId = part.messageID as string | undefined;
        const messageRole = messageId ? this.messageRoles.get(messageId) : undefined;
        const partType = part.type as string | undefined;
        const partTime = part.time as { start?: number; end?: number } | undefined;

        if (partType === "text") {
          // Skip user messages - agent-manager emits user_message via recordUserMessage
          if (messageRole === "user") {
            break;
          }
          // Skip if role unknown AND no delta (likely user message before role is known)
          if (!messageRole && !delta) {
            break;
          }
          // Emit delta for streaming, or full text only when complete (has time.end)
          if (delta) {
            events.push({
              type: "timeline",
              provider: "opencode",
              item: { type: "assistant_message", text: delta },
            });
          } else if (partTime?.end) {
            // Final complete text - only emit if we haven't been streaming deltas
            // (In practice, if delta was present, we've already streamed it all)
            const text = part.text as string | undefined;
            if (text) {
              events.push({
                type: "timeline",
                provider: "opencode",
                item: { type: "assistant_message", text },
              });
            }
          }
        } else if (partType === "reasoning") {
          // Emit delta for streaming reasoning
          if (delta) {
            events.push({
              type: "timeline",
              provider: "opencode",
              item: { type: "reasoning", text: delta },
            });
          } else if (partTime?.end) {
            const text = part.text as string | undefined;
            if (text) {
              events.push({
                type: "timeline",
                provider: "opencode",
                item: { type: "reasoning", text },
              });
            }
          }
        } else if (partType === "tool") {
          // Tool parts: { tool: string, state: { status, input, output?, error? } }
          const toolName = part.tool as string | undefined;
          const state = part.state as AgentMetadata | undefined;
          const status = state?.status as string | undefined;
          const input = state?.input as AgentMetadata | undefined;
          const output = state?.output as string | undefined;
          const error = state?.error as string | undefined;

          if (toolName) {
            events.push({
              type: "timeline",
              provider: "opencode",
              item: mapOpencodeToolCall({
                toolName,
                callId: (part.callID as string | undefined) ?? (part.id as string | undefined),
                status,
                input,
                output,
                error,
              }),
            });
          }
        } else if (partType === "step-finish") {
          // Extract usage from step-finish parts
          const tokens = part.tokens as { input?: number; output?: number; reasoning?: number } | undefined;
          const cost = part.cost as number | undefined;

          if (tokens) {
            this.accumulatedUsage.inputTokens = (this.accumulatedUsage.inputTokens ?? 0) + (tokens.input ?? 0);
            this.accumulatedUsage.outputTokens = (this.accumulatedUsage.outputTokens ?? 0) + (tokens.output ?? 0);
          }
          if (cost !== undefined) {
            this.accumulatedUsage.totalCostUsd = (this.accumulatedUsage.totalCostUsd ?? 0) + cost;
          }
        }
        break;
      }

      case "permission.asked": {
        // props IS the PermissionRequest directly
        const sessionId = props.sessionID as string | undefined;
        if (sessionId !== this.sessionId) {
          break;
        }

        const requestId = props.id as string;
        const permission = props.permission as string;
        const metadata = props.metadata as AgentMetadata | undefined;
        const patterns = props.patterns as string[] | undefined;

        const permRequest: AgentPermissionRequest = {
          id: requestId,
          provider: "opencode",
          name: permission,
          kind: "tool",
          title: permission,
          description: patterns?.join(", "),
          input: metadata,
        };

        this.pendingPermissions.set(requestId, permRequest);
        events.push({
          type: "permission_requested",
          provider: "opencode",
          request: permRequest,
        });
        break;
      }

      case "session.idle": {
        const sessionId = props.sessionID as string | undefined;
        if (sessionId === this.sessionId) {
          const usage = this.extractAndResetUsage();
          events.push({
            type: "turn_completed",
            provider: "opencode",
            usage,
          });
        }
        break;
      }

      case "session.error": {
        const sessionId = props.sessionID as string | undefined;
        if (sessionId === this.sessionId) {
          const error = props.error as string | undefined;
          events.push({
            type: "turn_failed",
            provider: "opencode",
            error: error ?? "Unknown error",
          });
        }
        break;
      }
    }

    return events;
  }

  private extractAndResetUsage(): AgentUsage | undefined {
    const usage = this.accumulatedUsage;
    this.accumulatedUsage = {};

    if (!usage.inputTokens && !usage.outputTokens && !usage.totalCostUsd) {
      return undefined;
    }

    return usage;
  }
}
