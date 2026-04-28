import type { ChildProcess } from "node:child_process";
import {
  createOpencodeClient,
  type AssistantMessage as OpenCodeAssistantMessage,
  type Event as OpenCodeEvent,
  type FilePartInput as OpenCodeFilePartInput,
  type OpencodeClient,
  type Part as OpenCodePart,
  type TextPartInput as OpenCodeTextPartInput,
} from "@opencode-ai/sdk/v2/client";
import net from "node:net";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
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
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ListModelsOptions,
  ListModesOptions,
  ListPersistedAgentsOptions,
  McpServerConfig,
  PersistedAgentDescriptor,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  applyProviderEnv,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable, isCommandAvailable } from "../../../utils/executable.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { mapOpencodeToolCall } from "./opencode/tool-call-mapper.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const OPENCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const DEFAULT_MODES: AgentMode[] = [
  {
    id: "build",
    label: "Build",
    description: "Allows edits and tool execution for implementation work",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
  },
];

type OpenCodeAgentConfig = AgentSessionConfig & { provider: "opencode" };
type OpenCodeMessageRole = "user" | "assistant";

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
const OPENCODE_PROVIDER_LIST_TIMEOUT_MS = 30_000;
const OPENCODE_FATAL_RETRY_MESSAGE_TOKENS = [
  "insufficient balance",
  "no resource package",
  "please recharge",
  "invalid api key",
  "unauthorized",
  "authentication",
  "model not found",
  "unknown model",
  "does not exist",
  "unsupported model",
] as const;

const OpencodeToolStateSchema = z
  .object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const OpencodeToolPartBaseSchema = z
  .object({
    tool: z.string().trim().min(1),
    state: OpencodeToolStateSchema.optional(),
  })
  .passthrough();

const OpencodeToolPartWithCallIdSchema = OpencodeToolPartBaseSchema.extend({
  callID: z.string().trim().min(1),
  id: z.string().optional(),
}).transform((part) => ({
  toolName: part.tool,
  callId: part.callID,
  status: part.state?.status,
  input: part.state?.input,
  output: part.state?.output,
  error: part.state?.error,
}));

const OpencodeToolPartWithIdSchema = OpencodeToolPartBaseSchema.extend({
  id: z.string().trim().min(1),
  callID: z.string().optional(),
}).transform((part) => ({
  toolName: part.tool,
  callId: part.id,
  status: part.state?.status,
  input: part.state?.input,
  output: part.state?.output,
  error: part.state?.error,
}));

const OpencodeToolPartWithoutIdSchema = OpencodeToolPartBaseSchema.extend({
  id: z.string().optional(),
  callID: z.string().optional(),
}).transform((part) => ({
  toolName: part.tool,
  callId: undefined,
  status: part.state?.status,
  input: part.state?.input,
  output: part.state?.output,
  error: part.state?.error,
}));

const OpencodeToolPartSchema = z.union([
  OpencodeToolPartWithCallIdSchema,
  OpencodeToolPartWithIdSchema,
  OpencodeToolPartWithoutIdSchema,
]);

const OpencodeToolPartTimelineEnvelopeSchema = OpencodeToolPartSchema.transform((part) => ({
  toolName: part.toolName,
  callId: part.callId,
  status: part.status,
  input: part.input,
  output: part.output,
  error: part.error,
}));

const OpencodeToolPartToTimelineItemSchema = OpencodeToolPartTimelineEnvelopeSchema.transform(
  (part) =>
    mapOpencodeToolCall({
      toolName: part.toolName,
      callId: part.callId,
      status: part.status,
      input: part.input,
      output: part.output,
      error: part.error,
    }),
);

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (found) {
    return found;
  }
  throw new Error(
    "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
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

function normalizeTurnFailureError(error: unknown): string {
  const normalized = stringifyUnknownError(error).trim();
  return normalized.length > 0 ? normalized : "Unknown error";
}

function isFatalOpenCodeRetryMessage(message: string | null | undefined): boolean {
  const normalized = typeof message === "string" ? message.trim().toLowerCase() : "";
  if (!normalized) {
    return false;
  }
  return OPENCODE_FATAL_RETRY_MESSAGE_TOKENS.some((token) => normalized.includes(token));
}

function isAlreadyPresentMcpError(error: unknown): boolean {
  const normalized = stringifyUnknownError(error).toLowerCase();
  return MCP_ALREADY_PRESENT_ERROR_TOKENS.some((token) => normalized.includes(token));
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

function resolvePartDedupeKey(
  part: { id: string; messageID: string },
  partType: "text" | "reasoning",
): string | null {
  if (part.id.trim().length > 0) {
    return `${partType}:${part.id}`;
  }
  if (part.messageID.trim().length > 0) {
    return `${partType}:message:${part.messageID}`;
  }
  return null;
}

function normalizeOpenCodeModeId(modeId: string | null | undefined): string {
  const trimmed = typeof modeId === "string" ? modeId.trim() : "";
  if (!trimmed || trimmed === "default") {
    return "build";
  }
  return trimmed;
}

function sortOpenCodeModes(modes: AgentMode[]): AgentMode[] {
  const order = new Map(DEFAULT_MODES.map((mode, index) => [mode.id, index]));
  return [...modes].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function buildOpenCodeModelLookupKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function parseOpenCodeModelLookupKey(modelId: string | null | undefined): string | undefined {
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    return undefined;
  }

  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelId.length - 1) {
    return undefined;
  }

  const providerId = modelId.slice(0, slashIndex).trim();
  const providerModelId = modelId.slice(slashIndex + 1).trim();
  if (!providerId || !providerModelId) {
    return undefined;
  }

  return buildOpenCodeModelLookupKey(providerId, providerModelId);
}

function extractOpenCodeModelContextWindow(model: unknown): number | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const limit = (model as { limit?: { context?: unknown } }).limit;
  return readPositiveFiniteNumber(limit?.context);
}

function buildOpenCodeModelDefinition(
  provider: {
    id: string;
    name: string;
  },
  modelId: string,
  model: {
    name: string;
    family?: string;
    release_date?: string;
    attachment?: boolean;
    reasoning?: boolean;
    tool_call?: boolean;
    cost?: unknown;
    limit?: { context?: number; input?: number; output?: number };
    variants?: Record<string, unknown>;
  },
): AgentModelDefinition {
  const rawVariants = model.variants ? Object.keys(model.variants) : [];
  const thinkingOptions = rawVariants.map((id, index) => ({
    id,
    label: id,
    isDefault: index === 0,
  }));

  return {
    provider: "opencode",
    id: `${provider.id}/${modelId}`,
    label: model.name,
    description: `${provider.name} - ${model.family ?? ""}`.trim(),
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId: thinkingOptions[0]?.id,
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
      contextWindowMaxTokens: extractOpenCodeModelContextWindow(model),
      ...(model.limit ? { limit: model.limit } : {}),
    },
  };
}

function resolveOpenCodeSelectedModelContextWindow(
  providers:
    | {
        connected?: string[];
        all?: Array<{
          id: string;
          models?: Record<string, unknown>;
        }>;
      }
    | null
    | undefined,
  modelId: string | null | undefined,
): number | undefined {
  if (!providers) {
    return undefined;
  }
  const modelLookupKey = parseOpenCodeModelLookupKey(modelId);
  if (!modelLookupKey) {
    return undefined;
  }
  const lookup = buildOpenCodeModelContextWindowLookup(providers);
  return lookup.get(modelLookupKey);
}

function buildOpenCodeModelContextWindowLookup(
  providers:
    | {
        connected?: string[];
        all?: Array<{
          id: string;
          models?: Record<string, unknown>;
        }>;
      }
    | null
    | undefined,
): Map<string, number> {
  const lookup = new Map<string, number>();
  if (!providers) {
    return lookup;
  }

  const connectedProviderIds = new Set(providers.connected ?? []);
  for (const provider of providers.all ?? []) {
    if (!connectedProviderIds.has(provider.id)) {
      continue;
    }
    for (const [modelId, modelDefinition] of Object.entries(provider.models ?? {})) {
      const contextWindow = extractOpenCodeModelContextWindow(modelDefinition);
      if (contextWindow === undefined) {
        continue;
      }
      lookup.set(buildOpenCodeModelLookupKey(provider.id, modelId), contextWindow);
    }
  }

  return lookup;
}

function resolveOpenCodeModelLookupKeyFromAssistantMessage(
  info: OpenCodeAssistantMessage,
): string | undefined {
  const providerId = info.providerID;
  const modelId = info.modelID;
  if (!providerId || !modelId) {
    return undefined;
  }

  return buildOpenCodeModelLookupKey(providerId, modelId);
}

function mergeOpenCodeStepFinishUsage(
  usage: AgentUsage,
  part: {
    cost?: unknown;
    tokens?: {
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      total?: unknown;
      cache?: {
        read?: unknown;
        write?: unknown;
      };
    };
  },
): void {
  const inputTokens = readPositiveFiniteNumber(part.tokens?.input);
  const outputTokens = readPositiveFiniteNumber(part.tokens?.output);
  const reasoningTokens = readPositiveFiniteNumber(part.tokens?.reasoning);
  const cacheReadTokens = readPositiveFiniteNumber(part.tokens?.cache?.read);
  const cacheWriteTokens = readPositiveFiniteNumber(part.tokens?.cache?.write);
  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheWriteTokens ?? 0);
  const cost = readPositiveFiniteNumber(part.cost);

  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (cacheReadTokens !== undefined) {
    usage.cachedInputTokens = cacheReadTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  if (totalTokens > 0) {
    usage.contextWindowUsedTokens = totalTokens;
  }
  if (cost !== undefined) {
    usage.totalCostUsd = (usage.totalCostUsd ?? 0) + cost;
  }
}

function hasNormalizedOpenCodeUsage(usage: AgentUsage): boolean {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.totalCostUsd,
    usage.contextWindowMaxTokens,
    usage.contextWindowUsedTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function getOpenCodeAttachmentExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function toOpenCodeDataUrl(mimeType: string, data: string): { mimeType: string; url: string } {
  const match = data.match(/^data:([^;,]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1] ?? mimeType,
      url: data,
    };
  }
  return {
    mimeType,
    url: `data:${mimeType};base64,${data}`,
  };
}

function buildOpenCodePromptParts(
  prompt: AgentPromptInput,
): Array<OpenCodeTextPartInput | OpenCodeFilePartInput> {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  let attachmentOrdinal = 0;
  const output: Array<OpenCodeTextPartInput | OpenCodeFilePartInput> = [];
  for (const part of prompt) {
    if (part.type === "text") {
      output.push({ type: "text", text: part.text });
      continue;
    }
    attachmentOrdinal += 1;
    const normalized = toOpenCodeDataUrl(part.mimeType, part.data);
    output.push({
      type: "file",
      mime: normalized.mimeType,
      filename: `attachment-${attachmentOrdinal}.${getOpenCodeAttachmentExtension(
        normalized.mimeType,
      )}`,
      url: normalized.url,
    });
  }
  return output;
}

export const __openCodeInternals = {
  buildOpenCodePromptParts,
  buildOpenCodeModelContextWindowLookup,
  buildOpenCodeModelDefinition,
  buildOpenCodeModelLookupKey,
  extractOpenCodeModelContextWindow,
  hasNormalizedOpenCodeUsage,
  mergeOpenCodeStepFinishUsage,
  parseOpenCodeModelLookupKey,
  resolveOpenCodeModelLookupKeyFromAssistantMessage,
  resolveOpenCodeSelectedModelContextWindow,
};

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
    runtimeSettings?: ProviderRuntimeSettings,
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
        "OpenCode server manager already initialized with different runtime settings",
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
    const launchPrefix = await resolveProviderCommandPrefix(
      this.runtimeSettings?.command,
      resolveOpenCodeBinary,
    );

    return new Promise((resolve, reject) => {
      this.server = spawnProcess(
        launchPrefix.command,
        [...launchPrefix.args, "serve", "--port", String(this.port)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: applyProviderEnv(process.env, this.runtimeSettings),
        },
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
  private readonly modelContextWindows = new Map<string, number>();

  constructor(logger: Logger, runtimeSettings?: ProviderRuntimeSettings) {
    this.logger = logger.child({ module: "agent", provider: "opencode" });
    this.runtimeSettings = runtimeSettings;
    this.serverManager = OpenCodeServerManager.getInstance(this.logger, runtimeSettings);
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
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

    await this.populateModelContextWindowCache(client, openCodeConfig.cwd);

    return new OpenCodeAgentSession(
      openCodeConfig,
      client,
      session.id,
      this.logger,
      new Map(this.modelContextWindows),
    );
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
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

    await this.populateModelContextWindowCache(client, openCodeConfig.cwd);

    return new OpenCodeAgentSession(
      openCodeConfig,
      client,
      handle.sessionId,
      this.logger,
      new Map(this.modelContextWindows),
    );
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const { url } = await this.serverManager.ensureRunning();
    const client = createOpencodeClient({
      baseUrl: url,
      directory: options?.cwd ?? process.cwd(),
    });

    // Background model discovery can be legitimately slow while OpenCode refreshes
    // provider state, so allow longer than turn execution paths.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `OpenCode provider.list timed out after ${OPENCODE_PROVIDER_LIST_TIMEOUT_MS / 1000}s - server may not be authenticated or connected to any providers`,
            ),
          ),
        OPENCODE_PROVIDER_LIST_TIMEOUT_MS,
      );
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
      throw new Error(
        "OpenCode has no connected providers. Please authenticate with at least one provider (e.g., openai, anthropic) or set appropriate environment variables (e.g., OPENAI_API_KEY).",
      );
    }

    const models: AgentModelDefinition[] = [];
    this.modelContextWindows.clear();
    for (const provider of providers.all) {
      // Skip providers that aren't connected/configured
      if (!connectedProviderIds.has(provider.id)) {
        continue;
      }

      for (const [modelId, model] of Object.entries(provider.models)) {
        const definition = buildOpenCodeModelDefinition(provider, modelId, model);
        const contextWindowMaxTokens = extractOpenCodeModelContextWindow(model);
        if (contextWindowMaxTokens !== undefined) {
          this.modelContextWindows.set(
            buildOpenCodeModelLookupKey(provider.id, modelId),
            contextWindowMaxTokens,
          );
        }
        models.push(definition);
      }
    }

    return models;
  }

  async listModes(options?: ListModesOptions): Promise<AgentMode[]> {
    const { url } = await this.serverManager.ensureRunning();
    const directory = options?.cwd ?? process.cwd();
    const client = createOpencodeClient({ baseUrl: url, directory });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OpenCode app.agents timed out after 10s")), 10_000);
    });

    const response = await Promise.race([client.app.agents({ directory }), timeoutPromise]);

    if (response.error || !response.data) {
      return DEFAULT_MODES;
    }

    const discovered = response.data
      .filter((agent) => agent.mode === "primary" && agent.hidden !== true)
      .map((agent) => ({
        id: agent.name,
        label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
        description:
          typeof agent.description === "string" && agent.description.trim().length > 0
            ? agent.description.trim()
            : DEFAULT_MODES.find((mode) => mode.id === agent.name)?.description,
      }));

    return discovered.length > 0 ? sortOpenCodeModes(discovered) : DEFAULT_MODES;
  }

  async listPersistedAgents(
    _options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    // TODO: Implement by listing sessions from OpenCode
    return [];
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace") {
      return await isCommandAvailable(command.argv[0]);
    }
    return true;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("opencode");
      let serverStatus = "Not running";
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      try {
        const { url } = await this.serverManager.ensureRunning();
        serverStatus = `Running (${url})`;
      } catch (error) {
        serverStatus = `Unavailable (${normalizeTurnFailureError(error)})`;
      }

      if (available) {
        try {
          const models = await this.listModels();
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }

        if (!modelsValue.startsWith("Error -")) {
          try {
            await this.listModes();
          } catch (error) {
            status = formatDiagnosticStatus(available, {
              source: "mode fetch",
              cause: error,
            });
          }
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("OpenCode", [
          {
            label: "Binary",
            value: resolvedBinary ?? "not found",
          },
          {
            label: "Version",
            value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
          },
          { label: "Server", value: serverStatus },
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("OpenCode", error),
      };
    }
  }
  private assertConfig(config: AgentSessionConfig): OpenCodeAgentConfig {
    if (config.provider !== "opencode") {
      throw new Error(`OpenCodeAgentClient received config for provider '${config.provider}'`);
    }
    return { ...config, provider: "opencode" };
  }

  private async populateModelContextWindowCache(
    client: OpencodeClient,
    cwd: string,
  ): Promise<void> {
    const response = await client.provider.list({ directory: cwd });
    if (response.error || !response.data) {
      return;
    }

    const lookup = buildOpenCodeModelContextWindowLookup(response.data);
    this.modelContextWindows.clear();
    for (const [modelLookupKey, contextWindowMaxTokens] of lookup.entries()) {
      this.modelContextWindows.set(modelLookupKey, contextWindowMaxTokens);
    }
  }
}

export type OpenCodeEventTranslationState = {
  sessionId: string;
  messageRoles: Map<string, OpenCodeMessageRole>;
  accumulatedUsage: AgentUsage;
  streamedPartKeys: Set<string>;
  emittedStructuredMessageIds: Set<string>;
  /** Tracks the type of each part by ID, learned from message.part.updated events. */
  partTypes: Map<string, string>;
  modelContextWindowsByModelKey?: ReadonlyMap<string, number>;
  onAssistantModelContextWindowResolved?: (contextWindowMaxTokens: number) => void;
};

function stringifyStructuredAssistantMessage(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function readOpenCodeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function translateOpenCodeEvent(
  event: OpenCodeEvent,
  state: OpenCodeEventTranslationState,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  switch (event.type) {
    case "session.created":
    case "session.updated": {
      if (event.properties.info.id === state.sessionId) {
        events.push({
          type: "thread_started",
          sessionId: state.sessionId,
          provider: "opencode",
        });
      }
      break;
    }

    case "message.updated": {
      const info = event.properties.info;
      if (info.sessionID !== state.sessionId) {
        break;
      }

      state.messageRoles.set(info.id, info.role);
      if (info.role === "assistant") {
        const modelLookupKey = resolveOpenCodeModelLookupKeyFromAssistantMessage(info);
        if (modelLookupKey) {
          const contextWindowMaxTokens = state.modelContextWindowsByModelKey?.get(modelLookupKey);
          if (contextWindowMaxTokens !== undefined) {
            state.onAssistantModelContextWindowResolved?.(contextWindowMaxTokens);
          }
        }

        if (!state.emittedStructuredMessageIds.has(info.id) && info.time?.completed !== undefined) {
          const text = stringifyStructuredAssistantMessage(info.structured);
          if (text) {
            state.emittedStructuredMessageIds.add(info.id);
            events.push({
              type: "timeline",
              provider: "opencode",
              item: { type: "assistant_message", text },
            });
          }
        }
      }
      break;
    }

    case "message.part.updated": {
      const part = event.properties.part;
      if (part.sessionID !== state.sessionId) {
        break;
      }

      const messageRole = state.messageRoles.get(part.messageID);
      state.partTypes.set(part.id, part.type);

      if (part.type === "text") {
        const partKey = resolvePartDedupeKey(part, "text");
        if (messageRole === "user") {
          break;
        }
        if (part.time?.end) {
          if (partKey && state.streamedPartKeys.delete(partKey)) {
            break;
          }
          if (part.text) {
            events.push({
              type: "timeline",
              provider: "opencode",
              item: { type: "assistant_message", text: part.text },
            });
          }
        }
      } else if (part.type === "reasoning") {
        const partKey = resolvePartDedupeKey(part, "reasoning");
        if (part.time.end) {
          if (partKey && state.streamedPartKeys.delete(partKey)) {
            break;
          }
          if (part.text) {
            events.push({
              type: "timeline",
              provider: "opencode",
              item: { type: "reasoning", text: part.text },
            });
          }
        }
      } else if (part.type === "tool") {
        const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
        if (parsedToolPart.success && parsedToolPart.data) {
          events.push({
            type: "timeline",
            provider: "opencode",
            item: parsedToolPart.data,
          });
        }
      } else if (part.type === "step-finish") {
        mergeOpenCodeStepFinishUsage(state.accumulatedUsage, part);
        if (hasNormalizedOpenCodeUsage(state.accumulatedUsage)) {
          events.push({
            type: "usage_updated",
            provider: "opencode",
            usage: { ...state.accumulatedUsage },
          });
        }
      }
      break;
    }

    case "message.part.delta": {
      const { sessionID, messageID, partID, field, delta } = event.properties;
      if (sessionID !== state.sessionId) {
        break;
      }

      if (!delta || !field) {
        break;
      }

      const messageRole = messageID ? state.messageRoles.get(messageID) : undefined;
      const knownPartType = partID ? state.partTypes.get(partID) : undefined;
      const isReasoning = knownPartType === "reasoning" || field === "reasoning";

      if (isReasoning) {
        if (partID) {
          state.streamedPartKeys.add(`reasoning:${partID}`);
        }
        events.push({
          type: "timeline",
          provider: "opencode",
          item: { type: "reasoning", text: delta },
        });
      } else if (field === "text") {
        if (messageRole === "user") {
          break;
        }
        if (partID) {
          state.streamedPartKeys.add(`text:${partID}`);
        }
        events.push({
          type: "timeline",
          provider: "opencode",
          item: { type: "assistant_message", text: delta },
        });
      }
      break;
    }

    case "permission.asked": {
      if (event.properties.sessionID !== state.sessionId) {
        break;
      }

      events.push({
        type: "permission_requested",
        provider: "opencode",
        request: {
          id: event.properties.id,
          provider: "opencode",
          name: event.properties.permission,
          kind: "tool",
          title: event.properties.permission,
          description: event.properties.patterns?.join(", "),
          input: event.properties.metadata,
        },
      });
      break;
    }

    case "question.asked": {
      if (event.properties.sessionID !== state.sessionId) {
        break;
      }

      const questions = event.properties.questions.flatMap((q) => {
        if (!q.question || !q.header) {
          return [];
        }
        const options =
          q.options?.map((o) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })) ?? [];
        return [
          {
            question: q.question,
            header: q.header,
            options,
            ...(q.multiple === true ? { multiSelect: true } : {}),
          },
        ];
      });

      if (questions.length === 0) {
        break;
      }

      events.push({
        type: "permission_requested",
        provider: "opencode",
        request: {
          id: event.properties.id,
          provider: "opencode",
          name: "question",
          kind: "question",
          title: "Question",
          input: { questions },
          metadata: {
            source: "opencode_question",
            ...(event.properties.tool ?? {}),
          },
        },
      });
      break;
    }

    case "session.idle": {
      if (event.properties.sessionID === state.sessionId) {
        state.streamedPartKeys.clear();
        state.partTypes.clear();
        events.push({
          type: "turn_completed",
          provider: "opencode",
          usage: undefined,
        });
      }
      break;
    }

    case "session.error": {
      if (event.properties.sessionID === state.sessionId) {
        state.streamedPartKeys.clear();
        state.partTypes.clear();
        events.push({
          type: "turn_failed",
          provider: "opencode",
          error: normalizeTurnFailureError(event.properties.error),
        });
      }
      break;
    }

    case "session.status": {
      if (event.properties.sessionID !== state.sessionId) {
        break;
      }
      const { status } = event.properties;
      if (status.type === "idle") {
        state.streamedPartKeys.clear();
        state.partTypes.clear();
        events.push({
          type: "turn_completed",
          provider: "opencode",
          usage: undefined,
        });
      } else if (status.type === "retry" && isFatalOpenCodeRetryMessage(status.message)) {
        state.streamedPartKeys.clear();
        state.partTypes.clear();
        events.push({
          type: "turn_failed",
          provider: "opencode",
          error: normalizeTurnFailureError(status.message),
        });
      }
      // "retry" and "busy" are transient — no terminal event.
      break;
    }
  }

  return events;
}

class OpenCodeAgentSession implements AgentSession {
  readonly provider: "opencode" = "opencode";
  readonly capabilities = OPENCODE_CAPABILITIES;

  private readonly config: OpenCodeAgentConfig;
  private readonly client: OpencodeClient;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly modelContextWindowsByModelKey: ReadonlyMap<string, number>;
  private currentMode: string = "default";
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private abortController: AbortController | null = null;
  private accumulatedUsage: AgentUsage = {};
  private mcpConfigured = false;
  private mcpSetupPromise: Promise<void> | null = null;
  /** Tracks the role of each message by ID to distinguish user from assistant messages */
  private messageRoles = new Map<string, OpenCodeMessageRole>();
  /** Tracks streamed textual part IDs to suppress final full-text echoes from OpenCode. */
  private streamedPartKeys = new Set<string>();
  /** Tracks assistant messages already emitted from structured payloads. */
  private emittedStructuredMessageIds = new Set<string>();
  /** Tracks the type of each part by ID, learned from message.part.updated events. */
  private partTypes = new Map<string, string>();
  private availableModesCache: AgentMode[] | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private nextTurnOrdinal = 0;
  private activeForegroundTurnId: string | null = null;
  private readonly runningToolCalls = new Map<string, ToolCallTimelineItem>();
  private selectedModelContextWindowMaxTokens: number | undefined;
  constructor(
    config: OpenCodeAgentConfig,
    client: OpencodeClient,
    sessionId: string,
    logger: Logger,
    modelContextWindowsByModelKey: ReadonlyMap<string, number> = new Map(),
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = sessionId;
    this.logger = logger;
    this.modelContextWindowsByModelKey = modelContextWindowsByModelKey;
    this.currentMode = normalizeOpenCodeModeId(config.modeId);
    this.selectedModelContextWindowMaxTokens = this.resolveConfiguredModelContextWindowMaxTokens(
      config.model,
    );
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
    this.selectedModelContextWindowMaxTokens = this.resolveConfiguredModelContextWindowMaxTokens(
      this.config.model,
    );
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;
    this.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let turnId: string | null = null;
    const bufferedEvents: AgentStreamEvent[] = [];
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;

    const processEvent = (event: AgentStreamEvent) => {
      if (settled) {
        return;
      }
      const eventTurnId = (event as { turnId?: string }).turnId;
      if (turnId && eventTurnId && eventTurnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text;
        }
        return;
      }
      if (event.type === "turn_completed") {
        usage = event.usage;
        settled = true;
        resolveCompletion();
        return;
      }
      if (event.type === "turn_failed") {
        settled = true;
        rejectCompletion(new Error(event.error));
        return;
      }
      if (event.type === "turn_canceled") {
        settled = true;
        resolveCompletion();
      }
    };

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const unsubscribe = this.subscribe((event) => {
      if (!turnId) {
        bufferedEvents.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const result = await this.startTurn(prompt, options);
      turnId = result.turnId;
      for (const event of bufferedEvents) {
        processEvent(event);
      }
      if (!settled) {
        await completion;
      }
    } finally {
      unsubscribe();
    }

    return {
      sessionId: this.sessionId,
      finalText,
      usage,
      timeline,
    };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeForegroundTurnId;
    const turnAbortController = this.abortController;
    turnAbortController?.abort();
    await this.client.session.abort({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });
    if (turnId) {
      this.finishForegroundTurn(
        { type: "turn_canceled", provider: "opencode", reason: "interrupted" },
        turnId,
      );
    }
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    this.runningToolCalls.clear();
    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;
    await this.ensureMcpServersConfigured();
    const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
    this.accumulatedUsage = contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};

    const parts = buildOpenCodePromptParts(prompt);
    const model = this.parseModel(this.config.model);
    const thinkingOptionId = this.config.thinkingOptionId;
    const effectiveVariant = thinkingOptionId ?? undefined;
    const effectiveMode = normalizeOpenCodeModeId(this.currentMode);

    const turnId = this.createTurnId();
    this.activeForegroundTurnId = turnId;
    void this.consumeEventStream(turnId, turnAbortController);

    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    if (slashCommand) {
      // command() blocks until the server finishes processing. OpenCode's SSE
      // endpoint does NOT replay past events, so if the command completes before
      // our SSE reader connects, we miss `session.idle` and the turn hangs.
      // Handle both success and error in the response handler as a fallback —
      // finishForegroundTurn's guard prevents duplicate terminal events if the
      // SSE stream already delivered the event.
      void this.client.session
        .command({
          sessionID: this.sessionId,
          directory: this.config.cwd,
          command: slashCommand.commandName,
          arguments: slashCommand.args ?? "",
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(effectiveMode ? { agent: effectiveMode } : {}),
          ...(effectiveVariant ? { variant: effectiveVariant } : {}),
        })
        .then((response) => {
          if (response.error) {
            const errorMsg = normalizeTurnFailureError(response.error);
            this.finishForegroundTurn(
              { type: "turn_failed", provider: "opencode", error: errorMsg },
              turnId,
            );
          } else {
            this.finishForegroundTurn(
              { type: "turn_completed", provider: "opencode", usage: undefined },
              turnId,
            );
          }
        })
        .catch((err) => {
          this.finishForegroundTurn(
            { type: "turn_failed", provider: "opencode", error: normalizeTurnFailureError(err) },
            turnId,
          );
        });
    } else {
      void this.client.session
        .promptAsync({
          sessionID: this.sessionId,
          directory: this.config.cwd,
          parts,
          ...(options?.outputSchema
            ? {
                format: {
                  type: "json_schema" as const,
                  schema: options.outputSchema as Record<string, unknown>,
                },
              }
            : {}),
          ...(this.config.systemPrompt ? { system: this.config.systemPrompt } : {}),
          ...(model ? { model } : {}),
          ...(effectiveMode ? { agent: effectiveMode } : {}),
          ...(effectiveVariant ? { variant: effectiveVariant } : {}),
        })
        .then((promptResponse) => {
          if (promptResponse.error) {
            this.finishForegroundTurn(
              {
                type: "turn_failed",
                provider: "opencode",
                error: normalizeTurnFailureError(promptResponse.error),
              },
              turnId,
            );
          }
        })
        .catch((error) => {
          this.finishForegroundTurn(
            {
              type: "turn_failed",
              provider: "opencode",
              error: normalizeTurnFailureError(error),
            },
            turnId,
          );
        });
    }

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async consumeEventStream(
    turnId: string,
    turnAbortController: AbortController,
  ): Promise<void> {
    try {
      const result = await this.client.event.subscribe(
        { directory: this.config.cwd },
        { signal: turnAbortController.signal, sseMaxRetryAttempts: 0 },
      );

      for await (const event of result.stream) {
        if (turnAbortController.signal.aborted || this.activeForegroundTurnId !== turnId) {
          break;
        }

        const translated = this.translateEvent(event);
        for (const e of translated) {
          if (this.activeForegroundTurnId !== turnId) {
            return;
          }
          if (e.type === "timeline" && e.item.type === "tool_call") {
            this.trackToolCall(e.item);
          }
          if (
            e.type === "turn_completed" ||
            e.type === "turn_failed" ||
            e.type === "turn_canceled"
          ) {
            if (e.type === "turn_failed") {
              this.finishForegroundTurn(
                {
                  type: "turn_failed",
                  provider: "opencode",
                  error: normalizeTurnFailureError(e.error),
                },
                turnId,
              );
            } else {
              this.finishForegroundTurn(e, turnId);
            }
            return;
          }
          this.notifySubscribers(e, turnId);
        }
      }

      if (!turnAbortController.signal.aborted && this.activeForegroundTurnId === turnId) {
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode",
            error: "OpenCode event stream ended before the turn reached a terminal state",
          },
          turnId,
        );
      }
    } catch (error) {
      if (!turnAbortController.signal.aborted && this.activeForegroundTurnId === turnId) {
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode",
            error: normalizeTurnFailureError(error),
          },
          turnId,
        );
      }
    } finally {
      if (turnAbortController.signal.aborted) {
        this.finishForegroundTurn(
          {
            type: "turn_canceled",
            provider: "opencode",
            reason: "interrupted",
          },
          turnId,
        );
      }
      if (this.abortController === turnAbortController && this.activeForegroundTurnId !== turnId) {
        this.abortController = null;
      }
    }
  }

  private finishForegroundTurn(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
    turnId: string,
  ): void {
    if (this.activeForegroundTurnId !== turnId) {
      return;
    }
    if (event.type === "turn_canceled" || event.type === "turn_failed") {
      this.synthesizeInterruptedToolCalls(turnId);
    } else {
      this.runningToolCalls.clear();
    }
    this.activeForegroundTurnId = null;
    // Abort the SSE connection so the SDK tears down the underlying fetch.
    this.abortController?.abort();
    this.abortController = null;
    this.notifySubscribers(event, turnId);
  }

  private trackToolCall(item: ToolCallTimelineItem): void {
    if (item.status === "running") {
      this.runningToolCalls.set(item.callId, item);
      return;
    }
    this.runningToolCalls.delete(item.callId);
  }

  private synthesizeInterruptedToolCalls(turnId: string): void {
    for (const item of this.runningToolCalls.values()) {
      this.notifySubscribers(
        {
          type: "timeline",
          provider: "opencode",
          item: {
            ...item,
            status: "failed",
            error: { message: "Tool execution aborted" },
          },
        },
        turnId,
      );
    }
    this.runningToolCalls.clear();
  }

  private notifySubscribers(event: AgentStreamEvent, turnIdOverride?: string): void {
    const turnId = turnIdOverride ?? this.activeForegroundTurnId;
    const tagged = turnId ? { ...event, turnId } : event;
    for (const callback of this.subscribers) {
      try {
        callback(tagged);
      } catch {
        // Subscriber callback error isolation
      }
    }
  }

  private createTurnId(): string {
    return `opencode-turn-${this.nextTurnOrdinal++}`;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const response = await this.client.session.messages({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });

    if (response.error || !response.data) {
      return;
    }

    for (const { info, parts } of response.data) {
      if (info.role === "user") {
        const text = parts
          .filter((p): p is Extract<OpenCodePart, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("");

        if (text) {
          yield {
            type: "timeline",
            provider: "opencode",
            item: { type: "user_message", text },
          };
        }
      } else {
        let emittedAssistantText = false;
        for (const part of parts) {
          if (part.type === "text") {
            if (part.text) {
              emittedAssistantText = true;
              yield {
                type: "timeline",
                provider: "opencode",
                item: { type: "assistant_message", text: part.text },
              };
            }
          } else if (part.type === "reasoning") {
            if (part.text) {
              yield {
                type: "timeline",
                provider: "opencode",
                item: { type: "reasoning", text: part.text },
              };
            }
          } else if (part.type === "tool") {
            const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
            if (parsedToolPart.success && parsedToolPart.data) {
              yield {
                type: "timeline",
                provider: "opencode",
                item: parsedToolPart.data,
              };
            }
          }
        }

        if (!emittedAssistantText) {
          const text = stringifyStructuredAssistantMessage(info.structured);
          if (text) {
            yield {
              type: "timeline",
              provider: "opencode",
              item: { type: "assistant_message", text },
            };
          }
        }
      }
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    if (this.availableModesCache) {
      return this.availableModesCache;
    }

    const response = await this.client.app.agents({
      directory: this.config.cwd,
    });

    const discoveredModes =
      response.error || !response.data
        ? []
        : response.data
            .filter((agent) => agent.mode === "primary" && agent.hidden !== true)
            .map((agent) => ({
              id: agent.name,
              label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
              description:
                typeof agent.description === "string" && agent.description.trim().length > 0
                  ? agent.description.trim()
                  : DEFAULT_MODES.find((mode) => mode.id === agent.name)?.description,
            }));

    this.availableModesCache =
      discoveredModes.length > 0 ? sortOpenCodeModes(discoveredModes) : DEFAULT_MODES;
    return this.availableModesCache;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const result = await this.client.command.list({
      directory: this.config.cwd,
    });
    if (result.error || !result.data) {
      return [];
    }
    return result.data.map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? "",
      argumentHint: cmd.hints?.length ? cmd.hints.join(" ") : "",
    }));
  }

  async setMode(modeId: string): Promise<void> {
    this.currentMode = normalizeOpenCodeModeId(modeId);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }

    if (pending.kind === "question") {
      if (response.behavior === "deny") {
        await this.client.question.reject({
          requestID: requestId,
          directory: this.config.cwd,
        });
      } else {
        const answersRecord = readOpenCodeRecord(response.updatedInput?.answers);
        const questions = Array.isArray(pending.input?.questions) ? pending.input.questions : [];
        const answers = questions.map((item) => {
          const header = readNonEmptyString(readOpenCodeRecord(item)?.header);
          const rawAnswer = header ? readNonEmptyString(answersRecord?.[header]) : null;
          if (!rawAnswer) {
            return [];
          }
          return rawAnswer
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        });

        await this.client.question.reply({
          requestID: requestId,
          directory: this.config.cwd,
          answers,
        });
      }

      this.pendingPermissions.delete(requestId);
      return;
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
    this.subscribers.clear();
    this.activeForegroundTurnId = null;
  }

  private parseSlashCommandInput(text: string): { commandName: string; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
  }

  private async resolveSlashCommandInvocation(
    prompt: AgentPromptInput,
  ): Promise<{ commandName: string; args?: string } | null> {
    if (typeof prompt !== "string") {
      return null;
    }
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) {
      return null;
    }
    try {
      const commands = await this.listCommands();
      return commands.some((command) => command.name === parsed.commandName) ? parsed : null;
    } catch (error) {
      this.logger.warn(
        { err: error, commandName: parsed.commandName },
        "Failed to resolve slash command; falling back to plain prompt input",
      );
      return null;
    }
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

  private async configureMcpServers(mcpServers: Record<string, McpServerConfig>): Promise<void> {
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const mappedConfig = toOpenCodeMcpConfig(serverConfig);
      await this.registerMcpServer(name, mappedConfig);
    }
  }

  private async registerMcpServer(name: string, config: OpenCodeMcpConfig): Promise<void> {
    await this.runMcpOperation("add", name, () =>
      this.client.mcp.add({
        directory: this.config.cwd,
        name,
        config,
      }),
    );
    await this.runMcpOperation("connect", name, () =>
      this.client.mcp.connect({
        directory: this.config.cwd,
        name,
      }),
    );
  }

  private async runMcpOperation(
    operation: "add" | "connect",
    name: string,
    run: () => Promise<{ error?: unknown }>,
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
      `Failed to ${operation} OpenCode MCP server '${name}': ${stringifyUnknownError(error)}`,
    );
  }

  private translateEvent(event: OpenCodeEvent): AgentStreamEvent[] {
    const translated = translateOpenCodeEvent(event, {
      sessionId: this.sessionId,
      messageRoles: this.messageRoles,
      accumulatedUsage: this.accumulatedUsage,
      streamedPartKeys: this.streamedPartKeys,
      emittedStructuredMessageIds: this.emittedStructuredMessageIds,
      partTypes: this.partTypes,
      modelContextWindowsByModelKey: this.modelContextWindowsByModelKey,
      onAssistantModelContextWindowResolved: (contextWindowMaxTokens) => {
        this.accumulatedUsage.contextWindowMaxTokens = contextWindowMaxTokens;
        if (!this.config.model) {
          this.selectedModelContextWindowMaxTokens = contextWindowMaxTokens;
        }
      },
    });

    for (const translatedEvent of translated) {
      if (translatedEvent.type === "permission_requested") {
        this.pendingPermissions.set(translatedEvent.request.id, translatedEvent.request);
      }
      if (translatedEvent.type === "turn_completed") {
        if (hasNormalizedOpenCodeUsage(this.accumulatedUsage)) {
          translatedEvent.usage = this.accumulatedUsage;
        }
        const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
        this.accumulatedUsage =
          contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};
      }
    }

    return translated;
  }

  private resolveSelectedModelContextWindowMaxTokens(): number | undefined {
    return this.selectedModelContextWindowMaxTokens;
  }

  private resolveConfiguredModelContextWindowMaxTokens(
    modelId: string | undefined,
  ): number | undefined {
    const modelLookupKey = parseOpenCodeModelLookupKey(modelId);
    if (!modelLookupKey) {
      return undefined;
    }
    return this.modelContextWindowsByModelKey.get(modelLookupKey);
  }
}
