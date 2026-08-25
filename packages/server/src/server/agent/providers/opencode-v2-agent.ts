import type { SessionMessageInfo } from "@opencode-ai/client";
import { ClientError } from "@opencode-ai/client";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateConfigUnattendedInput,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "../create-agent-mode.js";
import { execCommand } from "../../../utils/spawn.js";
import {
  raceProviderRefreshAbort,
  runProviderRefreshActivity,
} from "../provider-refresh-deadline.js";
import { runProviderTurn } from "./provider-runner.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { normalizeProviderReplayTimestamp } from "../provider-history-timestamps.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import {
  createOpenCodeV2Client,
  type OpenCodeV2ClientFactory,
  type OpenCodeV2ClientLike,
} from "./opencode-v2/client.js";
import {
  isOpenCodeV2CompactCommand,
  listOpenCodeV2Commands,
  parseOpenCodeV2SlashCommandInput,
} from "./opencode-v2/commands.js";
import {
  filterOpenCodeV2ModelInfosByCredentials,
  isSelectableOpenCodeV2Agent,
  mapOpenCodeV2AgentToMode,
  mapOpenCodeV2ModelToDefinition,
  readOpenCodeV2CredentialedProviderIds,
  sortOpenCodeV2Modes,
} from "./opencode-v2/catalog.js";
import { OpenCodeV2EventConsumer } from "./opencode-v2/event-consumer.js";
import {
  createOpenCodeV2EventTranslationState,
  resetOpenCodeV2TurnTrackingState,
  resolveOpenCodeV2PermissionReply,
  toOpenCodeV2TurnErrorMessage,
  translateOpenCodeV2Event,
  type OpenCodeV2EventTranslationState,
} from "./opencode-v2/event-translator.js";
import { mapOpenCodeV2ToolCall } from "./opencode-v2/tool-call-mapper.js";
import {
  OpenCodeV2ProviderOptionsSchema,
  buildOpenCodeV2PermissionRules,
  type OpenCodeV2ProviderOptions,
} from "./opencode-v2/options.js";
import { applyOpenCodeV2PermissionConfig } from "./opencode-v2/permission-config.js";
import { reconcileOpenCodeV2McpServers } from "./opencode-v2/mcp-config.js";
import {
  OpenCodeV2ServerManager,
  type OpenCodeV2EventSource,
  type OpenCodeV2EventSourceInput,
  type OpenCodeV2ServerAcquisition,
  type OpenCodeV2ServerManagerLike,
} from "./opencode-v2/server-manager.js";
import { resolveOpenCodeV2HomeDir } from "./opencode-v2/paths.js";
import type { ManagedProcessRegistry } from "../../managed-processes/managed-processes.js";

const OPENCODE_V2_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: true,
};

const EMPTY_OPENCODE_V2_EVENT_SOURCE: OpenCodeV2EventSource = {
  ready: async () => undefined,
  subscribe: () => () => undefined,
  close: async () => undefined,
};

/**
 * Cold-start mode refresh budget (VAL-OC2-REG-007). availableModes is captured
 * once at registration, before the freshly spawned opencode2 server is fully
 * ready; that fetch throws and leaves the list empty forever because
 * opencode-v2 emits no `mode_changed` stream event. Once the event stream is
 * ready, re-fetch getAvailableModes() and emit a `mode_changed` so the daemon
 * refreshes the agent's availableModes. Retry a few times in case the server
 * accepts the SSE stream before /api/agent is fully warmed up.
 */
const OPENCODE_V2_MODE_REFRESH_ATTEMPTS = 5;
const OPENCODE_V2_MODE_REFRESH_RETRY_DELAY_MS = 100;

const OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

function delayOpenCodeV2ModeRefresh(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpenCodeV2AutoAcceptEnabled(config: AgentSessionConfig): boolean {
  return config.featureValues?.[OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID] === true;
}

function withOpenCodeV2AutoAcceptFeature(
  featureValues: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...featureValues,
    [OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID]: enabled,
  };
}

/**
 * Apply provider-owned create-config defaults for opencode-v2. Unattended
 * creates (and children of unattended parents) get auto_accept enabled unless
 * the caller already set it, so an unattended agent does not pause on tool
 * permission prompts. There is no v2 legacy full-access mode (unlike v1), so
 * this only carries auto_accept; mode resolution delegates to the default.
 */
function resolveOpenCodeV2CreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const parent = input.parent;
  const isUnattendedCreate = input.unattended || parent?.isUnattended === true;
  const inheritsUnattended = input.requestedMode === undefined && isUnattendedCreate;
  const inheritedOpenCodeMode =
    inheritsUnattended && parent?.provider === input.provider
      ? (parent.modeId ?? undefined)
      : undefined;
  const requestedMode = input.requestedMode ?? inheritedOpenCodeMode;
  const featureValues =
    isUnattendedCreate && input.featureValues?.[OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID] === undefined
      ? withOpenCodeV2AutoAcceptFeature(input.featureValues, true)
      : input.featureValues;
  if (inheritsUnattended && requestedMode === undefined) {
    // Unattendedness for opencode-v2 is carried by auto_accept (set above), not
    // by any particular agent. Leave the mode unset so v2 uses its own default
    // agent — `build` may not exist in the user's opencode2 config.
    return { modeId: undefined, featureValues };
  }
  const resolved = resolveDefaultAgentCreateConfig({
    ...input,
    requestedMode,
    featureValues,
  });
  return { ...resolved, featureValues };
}

function isOpenCodeV2CreateConfigUnattended(input: AgentCreateConfigUnattendedInput): boolean {
  return (
    isDefaultAgentCreateConfigUnattended(input) ||
    input.config.featureValues?.[OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID] === true ||
    input.features?.some(
      (feature) =>
        feature.id === OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID &&
        (feature.value === true || feature.value === "true"),
    ) === true
  );
}

function buildOpenCodeV2AutoAcceptFeature(config: AgentSessionConfig): AgentFeature {
  return {
    type: "toggle",
    id: OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID,
    label: "Auto Accept",
    description: "Automatically approves OpenCode 2 tool permission prompts.",
    tooltip: "Auto accept permission prompts",
    icon: "shield-check",
    value: isOpenCodeV2AutoAcceptEnabled(config),
  };
}

type OpenCodeV2AgentConfig = Omit<AgentSessionConfig, "providerOptions"> & {
  provider: "opencode-v2";
  providerOptions: OpenCodeV2ProviderOptions;
};

type OpenCodeV2TurnState = { status: "idle" } | { status: "running"; turnId: string };

type OpenCodeV2TerminalTurnEvent = Extract<
  AgentStreamEvent,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

function toOpenCodeV2TerminalTurnEvent(
  event: AgentStreamEvent,
): OpenCodeV2TerminalTurnEvent | null {
  if (event.type === "turn_failed") {
    return {
      type: "turn_failed",
      provider: "opencode-v2",
      error: toDiagnosticErrorMessage(event.error),
    };
  }
  if (event.type === "turn_completed" || event.type === "turn_canceled") {
    return event;
  }
  return null;
}

function normalizeOpenCodeV2ModeId(modeId: string | null | undefined): string | null {
  const trimmed = typeof modeId === "string" ? modeId.trim() : "";
  if (!trimmed || trimmed === "default") {
    return null;
  }
  return trimmed;
}

function normalizeOpenCodeV2VariantId(variantId: string | null | undefined): string | null {
  const trimmed = typeof variantId === "string" ? variantId.trim() : "";
  if (!trimmed || trimmed === "default") {
    return null;
  }
  return trimmed;
}

function parseOpenCodeV2ModelRef(
  modelId: string | undefined,
): { id: string; providerID: string; variant?: string } | undefined {
  if (!modelId) {
    return undefined;
  }
  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelId.length - 1) {
    return undefined;
  }
  return {
    providerID: modelId.slice(0, slashIndex),
    id: modelId.slice(slashIndex + 1),
  };
}

const OPENCODE_V2_LAUNCH_ENV_DEFAULTS = new Set(["PASEO_AGENT_ID", "PASEO_AGENT_CWD"]);

/**
 * The agent manager always stamps `PASEO_AGENT_ID`/`PASEO_AGENT_CWD` onto the
 * launch context env. Those defaults are per-agent metadata, not a reason to
 * give the agent its own opencode2 server. Only genuinely custom env vars
 * (e.g. `--env FOO=bar`) require a dedicated server so they reach the spawned
 * process; otherwise agents share the ref-counted current server.
 */
function hasOpenCodeV2CustomLaunchEnv(env: Record<string, string> | undefined): boolean {
  if (!env) {
    return false;
  }
  return Object.keys(env).some((key) => !OPENCODE_V2_LAUNCH_ENV_DEFAULTS.has(key));
}

function buildOpenCodeV2PromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "image") {
        return "[Image]";
      }
      return renderPromptAttachmentAsText(part);
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function isOpenCodeV2DefinitiveSteerRejection(error: unknown): boolean {
  const message = toDiagnosticErrorMessage(error).toLowerCase();
  return /session\s+(?:is\s+)?(?:not found|inactive|not active|not running|idle)/.test(message);
}

/**
 * A permission/form reply that hit an expired or unknown request. The v2 client
 * surfaces these as a ClientError with an UnexpectedStatus reason; the daemon
 * treats them as a graceful no-op (the agent already moved on) rather than a
 * failure.
 */
function isOpenCodeV2StalePermissionError(error: unknown): boolean {
  if (error instanceof ClientError) {
    const status = (error.cause as { status?: number } | undefined)?.status ?? 0;
    return error.reason === "UnexpectedStatus" && status >= 400;
  }
  const message = toDiagnosticErrorMessage(error).toLowerCase();
  return (
    /(?:not found|expired|no longer|unknown|invalid).*(?:permission|request|form)/.test(message) ||
    /(?:permission|request|form).*(?:not found|expired|no longer|unknown|invalid)/.test(message)
  );
}

function extractOpenCodeV2ToolOutputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .map((entry) => {
      if (entry && typeof entry === "object" && "type" in entry && entry.type === "text") {
        const text = (entry as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      }
      return undefined;
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function parseOpenCodeV2ToolInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input;
}

function buildOpenCodeV2ReplayTimelineEvents(
  message: SessionMessageInfo,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  const timestamp = normalizeProviderReplayTimestamp(message.time?.created);
  const build = (item: AgentTimelineItem): Extract<AgentStreamEvent, { type: "timeline" }> => ({
    type: "timeline",
    provider: "opencode-v2",
    item,
    ...(timestamp ? { timestamp } : {}),
  });

  switch (message.type) {
    case "user":
      return buildOpenCodeV2UserReplayEvent(message, build);
    case "assistant":
      return buildOpenCodeV2AssistantReplayEvents(message, build);
    case "synthetic":
      return buildOpenCodeV2SyntheticReplayEvent(message, build);
    case "compaction":
      return buildOpenCodeV2CompactionReplayEvents(message, build);
    default:
      return [];
  }
}

function buildOpenCodeV2UserReplayEvent(
  message: Extract<SessionMessageInfo, { type: "user" }>,
  build: (item: AgentTimelineItem) => Extract<AgentStreamEvent, { type: "timeline" }>,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  const text = message.text;
  if (!text || text.trim().length === 0) {
    return [];
  }
  return [build({ type: "user_message", text, messageId: message.id })];
}

function buildOpenCodeV2SyntheticReplayEvent(
  message: Extract<SessionMessageInfo, { type: "synthetic" }>,
  build: (item: AgentTimelineItem) => Extract<AgentStreamEvent, { type: "timeline" }>,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  const text = message.text;
  if (!text || text.trim().length === 0) {
    return [];
  }
  return [build({ type: "assistant_message", text, messageId: message.id })];
}

function buildOpenCodeV2CompactionReplayEvents(
  message: Extract<SessionMessageInfo, { type: "compaction" }>,
  build: (item: AgentTimelineItem) => Extract<AgentStreamEvent, { type: "timeline" }>,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  if (message.status === "failed") {
    return [
      build({
        type: "error",
        message: `Compaction failed: ${message.error?.message ?? "unknown error"}`,
      }),
    ];
  }
  return [
    build({
      type: "compaction",
      status: message.status === "completed" ? "completed" : "loading",
      trigger: message.reason === "auto" ? "auto" : "manual",
    }),
  ];
}

function buildOpenCodeV2AssistantReplayEvents(
  message: Extract<SessionMessageInfo, { type: "assistant" }>,
  build: (item: AgentTimelineItem) => Extract<AgentStreamEvent, { type: "timeline" }>,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  const events: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text) {
      events.push(build({ type: "assistant_message", text: part.text, messageId: message.id }));
    } else if (part.type === "reasoning" && part.text) {
      events.push(build({ type: "reasoning", text: part.text }));
    } else if (part.type === "tool") {
      const item = buildOpenCodeV2ToolReplayItem(part, build);
      if (item) {
        events.push(item);
      }
    }
  }
  return events;
}

function buildOpenCodeV2ToolReplayItem(
  part: Extract<SessionMessageInfo, { type: "assistant" }>["content"][number] & { type: "tool" },
  build: (item: AgentTimelineItem) => Extract<AgentStreamEvent, { type: "timeline" }>,
): Extract<AgentStreamEvent, { type: "timeline" }> | null {
  const state = part.state;
  const metadata =
    state && "metadata" in state
      ? (state as { metadata?: Record<string, unknown> }).metadata
      : undefined;
  const item = mapOpenCodeV2ToolCall({
    toolName: part.name,
    callId: part.id,
    input: parseOpenCodeV2ToolInput(state?.input),
    output:
      state?.status === "completed" ? extractOpenCodeV2ToolOutputText(state?.content) : undefined,
    error: state?.status === "error" ? state?.error : undefined,
    status: state?.status,
    ...(metadata ? { metadata } : {}),
  });
  return item ? build(item) : null;
}

export interface OpenCodeV2AgentClientDeps {
  serverManager?: OpenCodeV2ServerManagerLike;
  createClient?: OpenCodeV2ClientFactory;
  managedProcesses?: ManagedProcessRegistry;
  readCredentialedProviderIds?: () => Promise<Set<string>>;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode-v2" as const;
  readonly capabilities = OPENCODE_V2_CAPABILITIES;
  readonly resolveCreateConfig = resolveOpenCodeV2CreateConfig;
  readonly isCreateConfigUnattended = isOpenCodeV2CreateConfigUnattended;

  private readonly serverManager: OpenCodeV2ServerManagerLike;
  private readonly createOpenCodeV2Client: OpenCodeV2ClientFactory;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly readCredentialedProviderIds: () => Promise<Set<string>>;

  constructor(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    deps: OpenCodeV2AgentClientDeps = {},
  ) {
    this.logger = logger.child({ module: "agent", provider: "opencode-v2" });
    this.runtimeSettings = runtimeSettings;
    this.createOpenCodeV2Client = deps.createClient ?? createOpenCodeV2Client;
    this.readCredentialedProviderIds =
      deps.readCredentialedProviderIds ??
      (() => readOpenCodeV2CredentialedProviderIds(this.runtimeSettings));
    this.serverManager =
      deps.serverManager ??
      OpenCodeV2ServerManager.getInstance(this.logger, runtimeSettings, {
        managedProcesses: deps.managedProcesses,
        createEventSource: ({
          serverUrl,
          password,
          authorization,
          processExit,
          logger: eventLogger,
        }) =>
          new OpenCodeV2EventConsumer({
            serverUrl,
            password,
            authorization,
            processExit,
            logger: eventLogger,
            createClient: this.createOpenCodeV2Client,
          }),
      });
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const openCodeV2Config = this.assertConfig(config);
    this.applyPermissionRules(openCodeV2Config);
    const launchEnv = launchContext?.env;
    const acquisition =
      launchEnv && hasOpenCodeV2CustomLaunchEnv(launchEnv)
        ? await this.serverManager.acquireDedicated(launchEnv)
        : await this.serverManager.acquireCurrent();
    const { url, authorization } = acquisition.server;
    const client = this.createOpenCodeV2Client({ baseUrl: url, authorization });

    try {
      const modelRef = parseOpenCodeV2ModelRef(openCodeV2Config.model);
      const modeId = normalizeOpenCodeV2ModeId(openCodeV2Config.modeId);
      const session = await client.session.create({
        location: { directory: openCodeV2Config.cwd },
        ...(modelRef ? { model: modelRef } : {}),
        ...(modeId ? { agent: modeId } : {}),
      });

      // Inject configured MCP servers before the session is returned, so the
      // tool set is ready before the first prompt (VAL-OC2-MCP-002). Failures
      // are non-fatal: diagnostics are logged and surfaced on the first turn.
      const mcpDiagnostics = await reconcileOpenCodeV2McpServers({
        client,
        mcpServers: openCodeV2Config.mcpServers,
        directory: openCodeV2Config.cwd,
        logger: this.logger,
      });

      return new OpenCodeV2AgentSession(
        openCodeV2Config,
        client,
        session.id,
        this.logger,
        acquisition.events,
        acquisition.release,
        options?.persistSession,
        launchContext?.agentId,
        mcpDiagnostics,
      );
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    _options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const cwd = overrides?.cwd ?? metadata.cwd;
    if (!cwd) {
      throw new Error("OpenCode 2 resume requires the original working directory");
    }

    const config: AgentSessionConfig = {
      ...metadata,
      ...overrides,
      provider: "opencode-v2",
      cwd,
    };
    const openCodeV2Config = this.assertConfig(config);
    this.applyPermissionRules(openCodeV2Config);
    const launchEnv = launchContext?.env;
    const acquisition =
      launchEnv && hasOpenCodeV2CustomLaunchEnv(launchEnv)
        ? await this.serverManager.acquireDedicated(launchEnv)
        : await this.serverManager.acquireCurrent();
    const { url, authorization } = acquisition.server;
    const client = this.createOpenCodeV2Client({ baseUrl: url, authorization });

    try {
      await client.session.get({ sessionID: handle.sessionId });
      // Reconcile MCP servers on resume too: re-adds configured servers
      // (idempotent) and removes any that are no longer in the config, so a
      // removed server's tools disappear (VAL-OC2-MCP-009).
      const mcpDiagnostics = await reconcileOpenCodeV2McpServers({
        client,
        mcpServers: openCodeV2Config.mcpServers,
        directory: openCodeV2Config.cwd,
        logger: this.logger,
      });
      return new OpenCodeV2AgentSession(
        openCodeV2Config,
        client,
        handle.sessionId,
        this.logger,
        acquisition.events,
        acquisition.release,
        undefined,
        launchContext?.agentId,
        mcpDiagnostics,
      );
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    let acquisition: OpenCodeV2ServerAcquisition | undefined;
    try {
      acquisition = options.force
        ? await this.serverManager.acquireNew(context?.signal)
        : await this.serverManager.acquireCurrent(context?.signal);
      context?.signal.throwIfAborted();
      const { url, authorization } = acquisition.server;
      const client = this.createOpenCodeV2Client({ baseUrl: url, authorization });
      const isGlobalCatalog = options.scope === "global";
      const directory = isGlobalCatalog ? resolveOpenCodeV2HomeDir() : options.cwd;
      const location = { directory };
      const credentialedProviderIds = await this.readCredentialedProviderIds();
      context?.signal.throwIfAborted();

      const [models, modes] = await Promise.all([
        this.fetchModelsFromClient(client, location, credentialedProviderIds, context),
        this.fetchModesFromClient(client, location, context),
      ]);
      return { models, modes };
    } finally {
      await acquisition?.release();
    }
  }

  private async fetchModelsFromClient(
    client: OpenCodeV2ClientLike,
    location: { directory: string },
    credentialedProviderIds: ReadonlySet<string>,
    context?: ProviderRefreshContext,
  ): Promise<AgentModelDefinition[]> {
    const response = await runProviderRefreshActivity(context, "model.list", () =>
      raceProviderRefreshAbort(context?.signal, client.model.list({ location })),
    );
    const filtered = filterOpenCodeV2ModelInfosByCredentials(
      response.data,
      credentialedProviderIds,
    );
    return filtered.map(mapOpenCodeV2ModelToDefinition);
  }

  private async fetchModesFromClient(
    client: OpenCodeV2ClientLike,
    location: { directory: string },
    context?: ProviderRefreshContext,
  ): Promise<AgentMode[]> {
    const response = await runProviderRefreshActivity(context, "agent.list", () =>
      raceProviderRefreshAbort(context?.signal, client.agent.list({ location })),
    );
    const discovered = response.data
      .filter(isSelectableOpenCodeV2Agent)
      .map(mapOpenCodeV2AgentToMode);
    return sortOpenCodeV2Modes(discovered);
  }

  async isAvailable(_signal?: AbortSignal): Promise<boolean> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: "opencode2",
    });
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "opencode2",
      });
      const availability = await checkProviderLaunchAvailable(launch);

      let authValue = "Not checked";
      const authCommand = availability.available
        ? (availability.resolvedPath ?? launch.command)
        : null;
      if (authCommand) {
        try {
          const { stdout, stderr } = await execCommand(
            authCommand,
            [...launch.args, "auth", "list"],
            {
              ...createProviderEnvSpec(),
              timeout: 5_000,
            },
          );
          const text = (stdout.trim() || stderr.trim()).trim();
          authValue = text ? `\n    ${text.replace(/\n/g, "\n    ")}` : "(empty)";
        } catch (error) {
          authValue = `Error - ${toDiagnosticErrorMessage(error)}`;
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("OpenCode 2", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["opencode2"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Auth", value: authValue },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("OpenCode 2", error),
      };
    }
  }

  async shutdown(): Promise<void> {
    await this.serverManager.shutdown();
  }

  private assertConfig(config: AgentSessionConfig): OpenCodeV2AgentConfig {
    if (config.provider !== "opencode-v2") {
      throw new Error(`OpenCodeV2AgentClient received config for provider '${config.provider}'`);
    }
    const providerOptions = OpenCodeV2ProviderOptionsSchema.parse(config.providerOptions ?? {});
    return { ...config, provider: "opencode-v2", providerOptions };
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [buildOpenCodeV2AutoAcceptFeature(this.assertConfig(config))];
  }

  async listCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const openCodeV2Config = this.assertConfig(config);
    const acquisition = await this.serverManager.acquireCurrent();
    const { url, authorization } = acquisition.server;
    const client = this.createOpenCodeV2Client({ baseUrl: url, authorization });

    try {
      return await listOpenCodeV2Commands(client, openCodeV2Config.cwd, this.logger);
    } finally {
      await acquisition.release();
    }
  }

  /**
   * Map the agent's `permission` provider option and exact-MCP preapproval
   * grants into v2 permission rules and write them into the isolated opencode2
   * config. Called before acquiring the server so a fresh spawn reads the rules
   * at startup; an already-running shared server reloads the config within ~1s.
   * The rules apply to every agent on the shared server (v2 permissions are
   * per-agent config, not per-session), so agents with conflicting permission
   * options should not share a server.
   */
  private applyPermissionRules(config: OpenCodeV2AgentConfig): void {
    const rules = buildOpenCodeV2PermissionRules(config.providerOptions, config.toolPolicy);
    // Write into the same isolated home the server manager runs servers in, so
    // the rules land in the config the server actually reads (the manager may
    // override its home for tests/isolated runs).
    applyOpenCodeV2PermissionConfig(rules, this.logger, this.serverManager.getHomeDir());
  }
}

export class OpenCodeV2AgentSession implements AgentSession {
  readonly provider = "opencode-v2" as const;
  readonly capabilities = OPENCODE_V2_CAPABILITIES;

  private readonly config: OpenCodeV2AgentConfig;
  private readonly client: OpenCodeV2ClientLike;
  private readonly logger: Logger;
  private readonly sessionId: string;
  private readonly events: OpenCodeV2EventSource;
  /** Provider id of the session's model (e.g. "openai"), for auth error messages. */
  private readonly providerId: string | null;
  private releaseServer: (() => Promise<void>) | null;
  private readonly persistSession: boolean;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private translationState: OpenCodeV2EventTranslationState;
  private turnState: OpenCodeV2TurnState = { status: "idle" };
  private currentMode: string | null;
  private autoAcceptEnabled: boolean;
  private abortController: AbortController | null = null;
  private closed = false;
  private ingress: Promise<void> = Promise.resolve();
  private unsubscribeEvents: (() => void) | null = null;
  private nextTurnOrdinal = 0;
  /** Non-fatal MCP server diagnostics to surface once, on the first turn. */
  private readonly mcpDiagnostics: string[];
  private mcpDiagnosticsEmitted = false;

  constructor(
    config: OpenCodeV2AgentConfig,
    client: OpenCodeV2ClientLike,
    sessionId: string,
    logger: Logger,
    events: OpenCodeV2EventSource = EMPTY_OPENCODE_V2_EVENT_SOURCE,
    releaseServer?: () => Promise<void>,
    persistSession = true,
    agentId?: string,
    mcpDiagnostics: string[] = [],
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = sessionId;
    this.logger = logger.child({ agentId });
    this.events = events;
    this.releaseServer = releaseServer ?? null;
    this.persistSession = persistSession;
    this.mcpDiagnostics = mcpDiagnostics;
    this.providerId = parseOpenCodeV2ModelRef(config.model)?.providerID ?? null;
    this.currentMode = normalizeOpenCodeV2ModeId(config.modeId);
    // A tool policy (exact MCP preapproval) governs tool access, so blanket
    // auto-accept is disabled when one is present (mirrors v1).
    this.autoAcceptEnabled = !config.toolPolicy && isOpenCodeV2AutoAcceptEnabled(config);
    this.translationState = createOpenCodeV2EventTranslationState(sessionId, {
      providerId: this.providerId,
    });
    this.unsubscribeEvents = this.events.subscribe((input) => {
      this.ingress = this.ingress
        .then(() => this.consumeEventSourceInput(input))
        .catch((error) => {
          this.logger.warn(
            { err: error, sessionId: this.sessionId },
            "OpenCode 2 event ingress failed",
          );
        });
    });
    // Cold-start fix: the daemon captures availableModes at registration, before
    // the freshly spawned server is ready, so it can be empty forever. Once the
    // event stream is ready, re-fetch modes and emit `mode_changed` to refresh it.
    void this.refreshModesWhenReady();
  }

  get id(): string | null {
    return this.sessionId;
  }

  private get activeForegroundTurnId(): string | null {
    return this.turnState.status === "running" ? this.turnState.turnId : null;
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: "opencode-v2",
      sessionId: this.sessionId,
      model: this.config.model ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
      modeId: this.currentMode,
    };
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionId,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("OpenCode 2 session is closed");
    }
    if (this.turnState.status === "running") {
      throw new Error("A foreground turn is already active");
    }
    const text = buildOpenCodeV2PromptText(prompt);
    if (!text || text.trim().length === 0) {
      throw new Error("A prompt is required");
    }

    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;
    this.translationState = createOpenCodeV2EventTranslationState(this.sessionId, {
      pendingUserMessageText: text,
      pendingClientMessageId: options?.clientMessageId ?? null,
      providerId: this.providerId,
    });

    const turnId = this.createTurnId();
    this.turnState = { status: "running", turnId };
    this.notifySubscribers({ type: "turn_started", provider: "opencode-v2" }, turnId);

    this.emitMcpDiagnostics();

    const parsedSlashCommand = parseOpenCodeV2SlashCommandInput(text);
    if (parsedSlashCommand) {
      // Built-in compact/summarize are handled directly: session.compact
      // triggers compaction events plus a normal execution turn, so the turn
      // completes on the server's `session.execution.succeeded` like any other
      // turn. Handled before resolving against the live listing so a built-in
      // never waits on the command registry.
      if (isOpenCodeV2CompactCommand(parsedSlashCommand.commandName)) {
        this.dispatchCompactTurn(turnId);
        return { turnId };
      }
      const resolved = await this.resolveOpenCodeV2SlashCommand(parsedSlashCommand);
      if (resolved) {
        this.dispatchCommandTurn(turnId, resolved.commandName, resolved.args ?? "");
        return { turnId };
      }
      // Unknown slash command: surface a clear notice, then send the raw text
      // as a plain prompt so the model can respond (e.g. explain the command is
      // not valid) and the session stays usable.
      this.notifySubscribers(
        {
          type: "timeline",
          provider: "opencode-v2",
          item: {
            type: "error",
            message: `Unknown command '/${parsedSlashCommand.commandName}'; sending as plain text`,
          },
        },
        turnId,
      );
    }

    void this.client.session
      .prompt({
        sessionID: this.sessionId,
        text,
        resume: true,
      })
      .then(() => undefined)
      .catch((error) => {
        if (this.activeForegroundTurnId !== turnId) {
          return;
        }
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode-v2",
            error: toOpenCodeV2TurnErrorMessage(error, this.providerId),
          },
          turnId,
        );
      });

    return { turnId };
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return await listOpenCodeV2Commands(this.client, this.config.cwd, this.logger);
  }

  /**
   * Resolve a parsed slash command against the live command listing. Returns
   * null when the command is unknown (or the listing could not be fetched), so
   * the caller falls back to plain prompt input. Unknown commands are never
   * dispatched to the server as commands — a message like "/etc/hosts" must
   * reach the model as plain text.
   */
  private async resolveOpenCodeV2SlashCommand(parsed: {
    commandName: string;
    args?: string;
  }): Promise<{ commandName: string; args?: string } | null> {
    try {
      const commands = await this.listCommands();
      return commands.some((command) => command.name === parsed.commandName) ? parsed : null;
    } catch (error) {
      this.logger.warn(
        { err: error, commandName: parsed.commandName },
        "Failed to resolve OpenCode 2 slash command; falling back to plain prompt input",
      );
      return null;
    }
  }

  private dispatchCommandTurn(turnId: string, commandName: string, text: string): void {
    void this.client.session
      .command({
        sessionID: this.sessionId,
        command: commandName,
        text,
      })
      .then(() => undefined)
      .catch((error) => {
        if (this.activeForegroundTurnId !== turnId) {
          return;
        }
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode-v2",
            error: toOpenCodeV2TurnErrorMessage(error, this.providerId),
          },
          turnId,
        );
      });
  }

  private dispatchCompactTurn(turnId: string): void {
    void this.client.session
      .compact({ sessionID: this.sessionId })
      .then(() => undefined)
      .catch((error) => {
        if (this.activeForegroundTurnId !== turnId) {
          return;
        }
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode-v2",
            error: toOpenCodeV2TurnErrorMessage(error, this.providerId),
          },
          turnId,
        );
      });
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.closed || this.activeForegroundTurnId !== options.expectedTurnId) {
      return { status: "unavailable" };
    }
    const text = buildOpenCodeV2PromptText(prompt);
    if (!text || text.trim().length === 0) {
      return { status: "unavailable" };
    }

    try {
      await this.client.session.prompt({
        sessionID: this.sessionId,
        text,
        delivery: "steer",
        resume: true,
      });
      if (options.clearPendingPermissions) {
        await this.clearPendingPermissionsForSteer();
      }
      return { status: "accepted" };
    } catch (error) {
      if (isOpenCodeV2DefinitiveSteerRejection(error)) {
        return { status: "unavailable" };
      }
      throw error;
    }
  }

  private async clearPendingPermissionsForSteer(): Promise<void> {
    const requestIds = Array.from(this.pendingPermissions.keys());
    for (const requestId of requestIds) {
      if (!this.pendingPermissions.has(requestId)) continue;
      await this.respondToPermission(requestId, {
        behavior: "deny",
        message: "The user answered with a message instead of approving. Their message follows.",
      });
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeForegroundTurnId;
    this.abortController?.abort();
    try {
      const response = await this.client.session.interrupt({ sessionID: this.sessionId });
      if (!response.interrupted && !turnId) {
        // Idle interrupt is a clean no-op.
        return;
      }
    } catch (error) {
      if (!turnId) {
        // An idle interrupt that errors is still a no-op; the session remains usable.
        return;
      }
      throw error;
    }
  }

  /**
   * Rewind the conversation and working tree to an earlier user message. v2
   * reverts in two phases: `revert.stage` computes the boundary and restores
   * files (returning a preview), then `revert.commit` truncates the transcript
   * to the staged message. Errors from either phase (e.g. an unknown message
   * id) propagate so the daemon can surface them cleanly.
   */
  async revertBoth(input: { messageId: string }): Promise<void> {
    await this.client.session.revert.stage({
      sessionID: this.sessionId,
      messageID: input.messageId,
    });
    await this.client.session.revert.commit({ sessionID: this.sessionId });
  }

  /**
   * Discard a staged rewind without committing it. The conversation and the
   * working tree are left unchanged; the session remains usable.
   */
  async revertClear(): Promise<void> {
    await this.client.session.revert.clear({ sessionID: this.sessionId });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const response = await this.client.message.list({ sessionID: this.sessionId });
    for (const message of response.data) {
      for (const event of buildOpenCodeV2ReplayTimelineEvents(message)) {
        yield event;
      }
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    const response = await this.client.agent.list({
      location: { directory: this.config.cwd },
    });
    const discovered = response.data
      .filter(isSelectableOpenCodeV2Agent)
      .map(mapOpenCodeV2AgentToMode);
    return sortOpenCodeV2Modes(discovered);
  }

  /**
   * Cold-start fix (VAL-OC2-REG-007): the daemon captures availableModes once
   * at registration, before the freshly spawned opencode2 server is ready, so
   * the list can be empty forever (opencode-v2 emits no `mode_changed` stream
   * event). Once the event source is ready (the server is serving requests),
   * re-fetch getAvailableModes() and emit a `mode_changed` so the daemon
   * refreshes the agent's availableModes. Best-effort: on failure the agent
   * keeps its registration-time list.
   */
  private async refreshModesWhenReady(): Promise<void> {
    try {
      await this.events.ready();
    } catch {
      return; // server exited or the source closed before becoming ready
    }
    if (this.closed) {
      return;
    }
    for (let attempt = 0; attempt < OPENCODE_V2_MODE_REFRESH_ATTEMPTS; attempt += 1) {
      try {
        const modes = await this.getAvailableModes();
        if (this.closed) {
          return;
        }
        if (modes.length === 0 && attempt < OPENCODE_V2_MODE_REFRESH_ATTEMPTS - 1) {
          // The server may accept the SSE stream before /api/agent is fully
          // warmed up; retry before emitting an empty list.
          await delayOpenCodeV2ModeRefresh(OPENCODE_V2_MODE_REFRESH_RETRY_DELAY_MS);
          continue;
        }
        this.notifySubscribers(
          {
            type: "mode_changed",
            provider: "opencode-v2",
            currentModeId: this.currentMode,
            availableModes: modes,
          },
          null,
        );
        return;
      } catch (error) {
        if (attempt >= OPENCODE_V2_MODE_REFRESH_ATTEMPTS - 1) {
          this.logger.warn(
            { err: error, sessionId: this.sessionId },
            "OpenCode 2 failed to refresh modes after server ready",
          );
          return;
        }
        await delayOpenCodeV2ModeRefresh(OPENCODE_V2_MODE_REFRESH_RETRY_DELAY_MS);
      }
    }
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async setMode(modeId: string): Promise<void> {
    const normalizedModeId = normalizeOpenCodeV2ModeId(modeId);
    if (normalizedModeId === null) {
      this.currentMode = null;
      this.config.modeId = undefined;
      return;
    }
    const availableModes = await this.getAvailableModes();
    if (!availableModes.some((mode) => mode.id === normalizedModeId)) {
      const available = availableModes.map((mode) => mode.id).join(", ") || "(none)";
      throw new Error(
        `Unknown mode '${normalizedModeId}' for OpenCode 2. Available modes: ${available}`,
      );
    }
    await this.client.session.switchAgent({
      sessionID: this.sessionId,
      agent: normalizedModeId,
    });
    this.currentMode = normalizedModeId;
    this.config.modeId = normalizedModeId;
  }

  async setModel(modelId: string | null): Promise<void> {
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;
    if (normalizedModelId === null) {
      this.config.model = undefined;
      return;
    }
    const modelRef = parseOpenCodeV2ModelRef(normalizedModelId);
    if (!modelRef) {
      throw new Error(
        `Invalid model id '${normalizedModelId}' for OpenCode 2. Expected providerID/modelID.`,
      );
    }
    const models = await this.fetchSessionModels();
    if (!models.some((model) => model.id === normalizedModelId)) {
      throw new Error(`Unknown model '${normalizedModelId}' for OpenCode 2.`);
    }
    await this.client.session.switchModel({
      sessionID: this.sessionId,
      model: { id: modelRef.id, providerID: modelRef.providerID },
    });
    this.config.model = normalizedModelId;
    this.notifySubscribers(
      {
        type: "model_changed",
        provider: "opencode-v2",
        runtimeInfo: await this.getRuntimeInfo(),
      },
      null,
    );
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const normalizedThinkingOptionId = normalizeOpenCodeV2VariantId(thinkingOptionId);
    if (this.config.model) {
      const modelRef = parseOpenCodeV2ModelRef(this.config.model);
      if (modelRef) {
        const models = await this.fetchSessionModels();
        const currentModel = models.find((model) => model.id === this.config.model);
        const thinkingOptions = currentModel?.thinkingOptions ?? [];
        if (
          normalizedThinkingOptionId !== null &&
          !thinkingOptions.some((option) => option.id === normalizedThinkingOptionId)
        ) {
          throw new Error(
            `Unknown thinking option '${normalizedThinkingOptionId}' for model '${this.config.model}'.`,
          );
        }
        await this.client.session.switchModel({
          sessionID: this.sessionId,
          model: {
            id: modelRef.id,
            providerID: modelRef.providerID,
            ...(normalizedThinkingOptionId ? { variant: normalizedThinkingOptionId } : {}),
          },
        });
      }
    }
    this.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
    this.notifySubscribers(
      {
        type: "thinking_option_changed",
        provider: "opencode-v2",
        thinkingOptionId: this.config.thinkingOptionId ?? null,
      },
      null,
    );
  }

  private async fetchSessionModels(): Promise<AgentModelDefinition[]> {
    const response = await this.client.model.list({
      location: { directory: this.config.cwd },
    });
    return response.data.map(mapOpenCodeV2ModelToDefinition);
  }

  get features(): AgentFeature[] {
    return [buildOpenCodeV2AutoAcceptFeature(this.config)];
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId !== OPENCODE_V2_AUTO_ACCEPT_FEATURE_ID) {
      throw new Error(`Unknown feature '${featureId}' for opencode-v2`);
    }
    const enabled = value === true || value === "true";
    this.config.featureValues = withOpenCodeV2AutoAcceptFeature(this.config.featureValues, enabled);
    this.autoAcceptEnabled = !this.config.toolPolicy && enabled;
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
      try {
        if (response.behavior === "deny") {
          await this.client.form.cancel({
            sessionID: this.sessionId,
            formID: requestId,
          });
        } else {
          const answers = readOpenCodeV2FormAnswers(pending, response);
          await this.client.form.reply({
            sessionID: this.sessionId,
            formID: requestId,
            answer: answers,
          });
        }
      } catch (error) {
        if (!isOpenCodeV2StalePermissionError(error)) {
          throw error;
        }
        // The request expired or the session went away; treat the reply as a
        // no-op and drop the stale pending entry.
        this.logger.debug(
          { err: error, sessionId: this.sessionId, requestId },
          "OpenCode 2 form reply hit a stale request; ignoring",
        );
      }
      this.pendingPermissions.delete(requestId);
      return;
    }

    const reply = resolveOpenCodeV2PermissionReply(response);
    try {
      await this.client.permission.reply({
        sessionID: this.sessionId,
        requestID: requestId,
        reply,
        ...(response.behavior === "deny" && response.message ? { message: response.message } : {}),
      });
    } catch (error) {
      if (!isOpenCodeV2StalePermissionError(error)) {
        throw error;
      }
      // The request expired or the session went away; treat the reply as a
      // no-op and drop the stale pending entry.
      this.logger.debug(
        { err: error, sessionId: this.sessionId, requestId },
        "OpenCode 2 permission reply hit a stale request; ignoring",
      );
    }
    this.pendingPermissions.delete(requestId);
    if (response.behavior === "deny" && response.interrupt) {
      await this.interrupt();
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "opencode-v2",
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.modeId ? { modeId: this.config.modeId } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
      },
    };
  }

  async close(): Promise<void> {
    try {
      this.closed = true;
      this.abortController?.abort();
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = null;
      await this.ingress.catch(() => undefined);
      this.subscribers.clear();
      this.turnState = { status: "idle" };
      if (!this.persistSession) {
        await this.client.session.remove({ sessionID: this.sessionId });
      }
    } finally {
      await this.releaseServer?.();
      this.releaseServer = null;
    }
  }

  private async consumeEventSourceInput(input: OpenCodeV2EventSourceInput): Promise<void> {
    if (input.type === "server-exited") {
      const turnId = this.activeForegroundTurnId;
      if (turnId) {
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode-v2",
            error: input.error.message,
          },
          turnId,
        );
      }
      return;
    }
    if (input.type === "reconnected") {
      return;
    }
    const translated = translateOpenCodeV2Event(input.event, this.translationState);
    for (const event of translated) {
      await this.handleTranslatedEvent(event);
    }
  }

  private async handleTranslatedEvent(event: AgentStreamEvent): Promise<void> {
    if (event.type === "permission_requested" && event.request.kind === "tool") {
      const approved = await this.tryAutoApproveToolPermission(event.request);
      if (approved) {
        // Auto-approved without surfacing: the tool proceeds on its own.
        return;
      }
    }
    const turnId = this.activeForegroundTurnId;
    if (!turnId) {
      // No active foreground turn. Background permission requests still surface
      // so a resumed session can show pending prompts.
      if (event.type === "permission_requested") {
        this.pendingPermissions.set(event.request.id, event.request);
        this.notifySubscribers(event, null);
      }
      return;
    }
    const terminalEvent = toOpenCodeV2TerminalTurnEvent(event);
    if (terminalEvent) {
      this.finishForegroundTurn(terminalEvent, turnId);
      return;
    }
    if (event.type === "permission_requested") {
      this.pendingPermissions.set(event.request.id, event.request);
    }
    this.notifySubscribers(event, turnId);
  }

  /**
   * Auto-approve a tool-kind permission request when auto_accept is enabled.
   * Forms are never auto-approved: they carry user input, not just tool access.
   * Returns true when the request was approved (and should not be surfaced).
   */
  private async tryAutoApproveToolPermission(request: AgentPermissionRequest): Promise<boolean> {
    if (!this.autoAcceptEnabled || request.kind !== "tool") {
      return false;
    }
    try {
      await this.client.permission.reply({
        sessionID: this.sessionId,
        requestID: request.id,
        reply: "once",
      });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: this.sessionId, requestId: request.id },
        "OpenCode 2 auto_accept permission reply failed",
      );
      return false;
    }
  }

  private finishForegroundTurn(event: OpenCodeV2TerminalTurnEvent, turnId: string): void {
    if (this.activeForegroundTurnId !== turnId) {
      return;
    }
    resetOpenCodeV2TurnTrackingState(this.translationState);
    this.turnState = { status: "idle" };
    this.abortController = null;
    this.notifySubscribers(event, turnId);
  }

  /**
   * Surface non-fatal MCP server diagnostics (e.g. a misconfigured server that
   * failed to connect) as timeline error items, once, on the first turn. The
   * session itself is unaffected: the prompt still runs without the failed
   * server's tools (VAL-OC2-MCP-005).
   */
  private emitMcpDiagnostics(): void {
    if (this.mcpDiagnosticsEmitted || this.mcpDiagnostics.length === 0) {
      return;
    }
    this.mcpDiagnosticsEmitted = true;
    for (const message of this.mcpDiagnostics) {
      this.notifySubscribers(
        {
          type: "timeline",
          provider: "opencode-v2",
          item: { type: "error", message },
        },
        null,
      );
    }
  }

  private notifySubscribers(event: AgentStreamEvent, turnIdOverride?: string | null): void {
    if (this.closed) {
      return;
    }
    const turnId = turnIdOverride === null ? null : (turnIdOverride ?? this.activeForegroundTurnId);
    const tagged = turnId ? { ...event, turnId } : event;
    for (const callback of this.subscribers) {
      try {
        callback(tagged);
      } catch {
        // A subscriber cannot tear down the session.
      }
    }
  }

  private createTurnId(): string {
    this.nextTurnOrdinal += 1;
    return `opencode-v2-turn-${this.nextTurnOrdinal}`;
  }
}

function readOpenCodeV2FormAnswers(
  pending: AgentPermissionRequest,
  response: AgentPermissionResponse,
): Record<string, string | number | boolean | string[]> {
  const answers: Record<string, string | number | boolean | string[]> = {};
  const questions = Array.isArray(pending.input?.questions) ? pending.input.questions : [];
  const updatedInput = response.behavior === "allow" ? response.updatedInput : undefined;
  const answersRecord = (updatedInput?.answers ?? {}) as Record<string, unknown>;
  for (const question of questions) {
    const key = readOpenCodeV2QuestionKey(question);
    if (!key) {
      continue;
    }
    const value = answersRecord[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      answers[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      answers[key] = value;
    } else if (Array.isArray(value)) {
      answers[key] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return answers;
}

function readOpenCodeV2QuestionKey(question: unknown): string | undefined {
  if (!question || typeof question !== "object") {
    return undefined;
  }
  const key = (question as { key?: unknown }).key;
  return typeof key === "string" && key.trim().length > 0 ? key : undefined;
}
