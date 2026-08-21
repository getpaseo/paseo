import {
  createOpencodeClient,
  type AssistantMessage as OpenCodeAssistantMessage,
  type Event as OpenCodeEvent,
  type FilePartInput as OpenCodeFilePartInput,
  type GlobalSession as OpenCodeGlobalSession,
  type Message as OpenCodeMessage,
  type OpencodeClient,
  type OpencodeClientConfig,
  type Part as OpenCodePart,
  type Session as OpenCodeSession,
  type TextPartInput as OpenCodeTextPartInput,
} from "@opencode-ai/sdk/v2/client";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createPathEquivalenceMatcher } from "../../../utils/path.js";
import pLimit from "p-limit";
import type { Logger } from "pino";
import { z } from "zod";

import {
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionAction,
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
  type AgentTimelineItem,
  type AgentUsage,
  type FetchCatalogOptions,
  type ProviderRefreshContext,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ResolveAgentCreateConfigInput,
  type ResolveAgentCreateConfigResult,
  type AgentMcpReport,
  type AgentMcpServer,
  type AgentMcpServerStatus,
  type McpServerConfig,
  type ProviderCatalog,
  type SteerActiveTurnOptions,
  type SteerResult,
  type ToolCallDetail,
  type ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import {
  raceProviderRefreshAbort,
  runProviderRefreshActivity,
} from "../provider-refresh-deadline.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "../create-agent-mode.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { withTimeout } from "../../../utils/promise-timeout.js";
import { execCommand } from "../../../utils/spawn.js";
import { mapOpencodeToolCall } from "./opencode/tool-call-mapper.js";
import {
  OpenCodeServerManager,
  OPENCODE_SERVER_STARTUP_TIMEOUT_MS,
  type OpenCodeServerAcquisition,
  type OpenCodeServerManagerLike,
} from "./opencode/server-manager.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventSource,
  type OpenCodeEventSourceInput,
} from "./opencode/event-consumer.js";
import { resolveOpenCodeHomeDir } from "./opencode/paths.js";
import {
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import { runProviderTurn } from "./provider-runner.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { composeSystemPromptParts } from "../system-prompt.js";
import { normalizeProviderReplayTimestamp } from "../provider-history-timestamps.js";
import { revertOpenCodeConversationAndFiles } from "./opencode/rewind.js";
import {
  claimOpenCodeSubagentFallbackTitle,
  foldOpenCodeSubagentPresentation,
  type OpenCodeSubagentPresentationFacts,
  type OpenCodeSubagentPresentationState,
} from "./opencode/subagent-presentation.js";
import type { ManagedProcessRegistry } from "../../managed-processes/managed-processes.js";
import {
  buildOpenCodePermissionRules,
  OpenCodeProviderOptionsSchema,
  type OpenCodeProviderOptions,
} from "./opencode/options.js";

const OPENCODE_CAPABILITIES: AgentCapabilityFlags = {
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
  supportsMcpStatus: true,
};

function normalizeOpenCodeMcpStatus(status: string): AgentMcpServerStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "disabled":
      return "disabled";
    // OpenCode splits "you have to authenticate" into a plain OAuth case and a
    // dynamic-client-registration case. Both mean the same thing to a reader.
    case "needs_auth":
    case "needs_client_registration":
      return "needs_auth";
    default:
      return "unknown";
  }
}

const OPENCODE_BUILD_MODE_ID = "build";
const OPENCODE_LEGACY_FULL_ACCESS_MODE_ID = "full-access";
const OPENCODE_DEFAULT_VARIANT_ID = "default";
const EMPTY_OPENCODE_EVENT_SOURCE: OpenCodeEventSource = {
  ready: async () => undefined,
  subscribe: () => () => undefined,
};
const OPENCODE_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastOpenCodeMessageTimestamp = -1;
let openCodeMessageCounter = 0;

function createOpenCodeMessageId(
  now = Date.now(),
  random = (length: number) =>
    Array.from(randomBytes(length), (value) => OPENCODE_ID_ALPHABET[value % 62]).join(""),
): string {
  if (now !== lastOpenCodeMessageTimestamp) openCodeMessageCounter = 0;
  lastOpenCodeMessageTimestamp = now;
  openCodeMessageCounter += 1;
  const ascending = (BigInt(now) * 0x1000n + BigInt(openCodeMessageCounter))
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  return `msg_${ascending}${random(14)}`;
}
const OPENCODE_AUTO_ACCEPT_FEATURE_ID = "auto_accept";
const OPENCODE_PERSISTED_SESSION_LIMIT = 200;
const OPENCODE_PENDING_ABORT_START_TIMEOUT_MS = 10_000;
const OPENCODE_CHILD_SESSION_HYDRATION_LIMIT = 100;
const OPENCODE_STOP_STATUS_MAX_DELAY_MS = 1_000;

function waitForOpenCodeStopProbe(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs).unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function recoverChildStatus(snapshot: boolean, type: unknown, assistant?: OpenCodeSessionMessage) {
  if (type === "busy" || type === "retry") return "running";
  if (assistant && "error" in assistant.info && assistant.info.error) return "failed";
  const time = assistant?.info.time;
  if (snapshot || (time && "completed" in time && time.completed !== undefined)) return "completed";
}

const OPENCODE_CHILD_SESSION_SERVER_REGISTRY_LIMIT = 500;
const OPENCODE_PERMISSION_ACTION_ALLOW_ONCE = "allow_once";
const OPENCODE_PERMISSION_ACTION_ALLOW_ALWAYS = "allow_always";

// OpenCode child sessions run on the server process that spawned them. Adoption
// resumes must attach to that same helper server to receive live global events.
const openCodeChildSessionServerUrls = new Map<string, string>();

function registerOpenCodeChildSessionServerUrl(sessionId: string, serverUrl: string): void {
  openCodeChildSessionServerUrls.delete(sessionId);
  openCodeChildSessionServerUrls.set(sessionId, serverUrl);
  if (openCodeChildSessionServerUrls.size <= OPENCODE_CHILD_SESSION_SERVER_REGISTRY_LIMIT) {
    return;
  }
  const oldestSessionId = openCodeChildSessionServerUrls.keys().next().value;
  if (typeof oldestSessionId === "string") {
    openCodeChildSessionServerUrls.delete(oldestSessionId);
  }
}

function unregisterOpenCodeChildSessionServerUrl(sessionId: string): void {
  openCodeChildSessionServerUrls.delete(sessionId);
}

function getOpenCodeChildSessionServerUrl(sessionId: string): string | undefined {
  return openCodeChildSessionServerUrls.get(sessionId);
}

const DEFAULT_MODES: AgentMode[] = [
  {
    id: OPENCODE_BUILD_MODE_ID,
    label: "Build",
    description: "Allows edits and tool execution for implementation work",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
  },
];

function isOpenCodeAutoAcceptEnabled(config: AgentSessionConfig): boolean {
  return config.featureValues?.[OPENCODE_AUTO_ACCEPT_FEATURE_ID] === true;
}

function withOpenCodeAutoAcceptFeature(
  featureValues: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...featureValues,
    [OPENCODE_AUTO_ACCEPT_FEATURE_ID]: enabled,
  };
}

function resolveOpenCodeCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const legacyFullAccess = input.requestedMode === OPENCODE_LEGACY_FULL_ACCESS_MODE_ID;
  const parent = input.parent;
  const isUnattendedCreate = input.unattended || parent?.isUnattended === true;
  const inheritsUnattended = input.requestedMode === undefined && isUnattendedCreate;
  const inheritedOpenCodeMode =
    inheritsUnattended && parent?.provider === input.provider
      ? (parent.modeId ?? undefined)
      : undefined;
  const requestedMode = legacyFullAccess
    ? OPENCODE_BUILD_MODE_ID
    : (input.requestedMode ?? inheritedOpenCodeMode);
  const featureValues =
    legacyFullAccess ||
    (isUnattendedCreate && input.featureValues?.[OPENCODE_AUTO_ACCEPT_FEATURE_ID] === undefined)
      ? withOpenCodeAutoAcceptFeature(input.featureValues, true)
      : input.featureValues;

  if (inheritsUnattended && requestedMode === undefined) {
    // Unattendedness for OpenCode is carried by auto_accept (set above), not
    // by any particular agent. Leave the mode unset so OpenCode uses its own
    // default agent — `build` may not exist in the user's OpenCode config.
    return { modeId: undefined, featureValues };
  }

  const resolved = resolveDefaultAgentCreateConfig({
    ...input,
    requestedMode,
    featureValues,
  });
  return { ...resolved, featureValues };
}

function isOpenCodeCreateConfigUnattended(
  input: Parameters<typeof isDefaultAgentCreateConfigUnattended>[0],
): boolean {
  return (
    isDefaultAgentCreateConfigUnattended(input) ||
    input.config.featureValues?.[OPENCODE_AUTO_ACCEPT_FEATURE_ID] === true ||
    input.features?.some(
      (feature) =>
        feature.id === OPENCODE_AUTO_ACCEPT_FEATURE_ID &&
        (feature.value === true || feature.value === "true"),
    ) === true
  );
}

function buildOpenCodeAutoAcceptFeature(config: AgentSessionConfig): AgentFeature {
  return {
    type: "toggle",
    id: OPENCODE_AUTO_ACCEPT_FEATURE_ID,
    label: "Auto Accept",
    description: "Automatically approves OpenCode tool permission prompts.",
    tooltip: "Auto accept permission prompts",
    icon: "shield-check",
    value: isOpenCodeAutoAcceptEnabled(config),
  };
}

function buildOpenCodePermissionActions(): AgentPermissionAction[] {
  return [
    {
      id: "deny",
      label: "Deny",
      behavior: "deny",
      variant: "danger",
      intent: "dismiss",
    },
    {
      id: OPENCODE_PERMISSION_ACTION_ALLOW_ALWAYS,
      label: "Allow always",
      behavior: "allow",
      variant: "secondary",
    },
    {
      id: OPENCODE_PERMISSION_ACTION_ALLOW_ONCE,
      label: "Allow once",
      behavior: "allow",
      variant: "primary",
    },
  ];
}

function resolveOpenCodePermissionReply(
  response: AgentPermissionResponse,
): "once" | "always" | "reject" {
  if (response.behavior === "deny") {
    return "reject";
  }

  if (response.selectedActionId === OPENCODE_PERMISSION_ACTION_ALLOW_ALWAYS) {
    return "always";
  }

  return "once";
}

type OpenCodeAgentConfig = Omit<AgentSessionConfig, "providerOptions"> & {
  provider: "opencode";
  providerOptions: OpenCodeProviderOptions;
};
type OpenCodeMessageRole = "user" | "assistant";
type OpenCodePersistedSession = OpenCodeSession | OpenCodeGlobalSession;

interface OpenCodeSessionMessage {
  info: OpenCodeMessage;
  parts: OpenCodePart[];
}

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
const OPENCODE_METADATA_CONCURRENCY = 4;
const openCodeMetadataLimit = pLimit(OPENCODE_METADATA_CONCURRENCY);

const OPENCODE_HANDLED_BUILTIN_SLASH_COMMANDS: AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Compact the current session",
    argumentHint: "",
    kind: "command",
  },
  {
    name: "summarize",
    description: "Compact the current session",
    argumentHint: "",
    kind: "command",
  },
];
const OPENCODE_HEADERS_TIMEOUT_TOKENS = [
  "headers timeout",
  "headers timeout error",
  "headers_timeout",
  "und_err_headers_timeout",
] as const;

const OpencodeToolStateSchema = z
  .object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
  metadata: part.state?.metadata,
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
  metadata: part.state?.metadata,
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
  metadata: part.state?.metadata,
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
  metadata: part.metadata,
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
      metadata: part.metadata,
    }),
);

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

type TerminalTurnEvent = Extract<
  AgentStreamEvent,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
>;

function toTerminalTurnEvent(event: AgentStreamEvent): TerminalTurnEvent | null {
  if (event.type === "turn_failed") {
    return {
      type: "turn_failed",
      provider: "opencode",
      error: toDiagnosticErrorMessage(event.error),
    };
  }
  if (event.type === "turn_completed" || event.type === "turn_canceled") {
    return event;
  }
  return null;
}

function isOpenCodeNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotFoundError"
  );
}

async function abortOpenCodeSession(params: {
  client: Pick<OpencodeClient, "session">;
  sessionId: string;
  directory: string;
  logger: Logger;
}): Promise<void> {
  const { client, sessionId, directory, logger } = params;

  try {
    const response = await client.session.abort({
      sessionID: sessionId,
      directory,
    });
    if (response.error && !isOpenCodeNotFoundError(response.error)) {
      logger.warn(
        {
          sessionId,
          error: toDiagnosticErrorMessage(response.error),
        },
        "Failed to abort OpenCode session during close",
      );
    }
  } catch (error) {
    logger.warn(
      {
        sessionId,
        error: toDiagnosticErrorMessage(error),
      },
      "Failed to abort OpenCode session during close",
    );
  }
}

function isOpenCodeHeadersTimeoutFailure(error: unknown): boolean {
  const diagnostics = new Set<string>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const normalized = toDiagnosticErrorMessage(current).trim().toLowerCase();
    if (normalized) {
      diagnostics.add(normalized);
    }

    if (typeof current === "object") {
      const record = current as {
        message?: unknown;
        code?: unknown;
        name?: unknown;
        cause?: unknown;
      };

      for (const value of [record.message, record.code, record.name]) {
        if (typeof value !== "string") {
          continue;
        }
        const diagnostic = value.trim().toLowerCase();
        if (diagnostic) {
          diagnostics.add(diagnostic);
        }
      }

      if (record.cause) {
        queue.push(record.cause);
      }
    }
  }

  return [...diagnostics].some((diagnostic) =>
    OPENCODE_HEADERS_TIMEOUT_TOKENS.some((token) => diagnostic.includes(token)),
  );
}

function isAlreadyPresentMcpError(error: unknown): boolean {
  const normalized = toDiagnosticErrorMessage(error).toLowerCase();
  return MCP_ALREADY_PRESENT_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function readOpenCodeMcpOperationError(data: unknown, name: string): unknown {
  const root = readOpenCodeRecord(data);
  const entry = readOpenCodeRecord(root?.[name]);
  if (!entry || entry.status !== "failed") {
    return undefined;
  }
  return entry.error ?? `OpenCode reported MCP server '${name}' failed`;
}

function matchesHydratedFingerprint(
  fingerprints: Map<string, string> | undefined,
  id: string,
  value: unknown,
): boolean {
  const hydratedFingerprint = fingerprints?.get(id);
  if (!hydratedFingerprint) {
    return false;
  }
  fingerprints?.delete(id);
  return hydratedFingerprint === JSON.stringify(value);
}

// `null` = no explicit mode. The `agent` field is then omitted from OpenCode
// prompt/command calls so OpenCode falls back to its own configured default
// agent — never assume any particular agent (even `build`) exists, since
// OpenCode users can define or delete agents at will.
function normalizeOpenCodeModeId(modeId: string | null | undefined): string | null {
  const trimmed = typeof modeId === "string" ? modeId.trim() : "";
  if (!trimmed || trimmed === "default") {
    return null;
  }
  return trimmed;
}

function normalizeOpenCodeVariantId(variantId: string | null | undefined): string | null {
  const trimmed = typeof variantId === "string" ? variantId.trim() : "";
  if (!trimmed || trimmed === OPENCODE_DEFAULT_VARIANT_ID) {
    return null;
  }
  return trimmed;
}

function resolveOpenCodeRuntimeAgentId(modeId: string | null | undefined): string | undefined {
  const normalizedModeId = normalizeOpenCodeModeId(modeId);
  if (normalizedModeId === null) {
    return undefined;
  }
  return normalizedModeId === OPENCODE_LEGACY_FULL_ACCESS_MODE_ID
    ? OPENCODE_BUILD_MODE_ID
    : normalizedModeId;
}

function normalizeOpenCodeConfig(config: OpenCodeAgentConfig): OpenCodeAgentConfig {
  const normalized = {
    ...config,
    thinkingOptionId: normalizeOpenCodeVariantId(config.thinkingOptionId) ?? undefined,
  };
  if (normalizeOpenCodeModeId(normalized.modeId) !== OPENCODE_LEGACY_FULL_ACCESS_MODE_ID) {
    return normalized;
  }

  return {
    ...normalized,
    modeId: OPENCODE_BUILD_MODE_ID,
    featureValues: {
      ...normalized.featureValues,
      [OPENCODE_AUTO_ACCEPT_FEATURE_ID]: true,
    },
  };
}

function isSelectableOpenCodeAgent(agent: { mode?: string; hidden?: boolean }): boolean {
  return (agent.mode === "primary" || agent.mode === "all") && agent.hidden !== true;
}

const OPENCODE_AGENT_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function readOpenCodeAgentHexColor(agent: { color?: unknown }): string | undefined {
  return typeof agent.color === "string" && OPENCODE_AGENT_HEX_COLOR_PATTERN.test(agent.color)
    ? agent.color
    : undefined;
}

function mapOpenCodeAgentToMode(agent: {
  name: string;
  description?: unknown;
  color?: unknown;
}): AgentMode {
  const colorTier = readOpenCodeAgentHexColor(agent);
  return {
    id: agent.name,
    label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
    icon: "Bot",
    description:
      typeof agent.description === "string" && agent.description.trim().length > 0
        ? agent.description.trim()
        : DEFAULT_MODES.find((mode) => mode.id === agent.name)?.description,
    ...(colorTier ? { colorTier } : {}),
  };
}

function mergeOpenCodeModes(discoveredModes: AgentMode[]): AgentMode[] {
  const filtered = discoveredModes.filter(
    (mode) => mode.id !== OPENCODE_LEGACY_FULL_ACCESS_MODE_ID,
  );
  // When discovery returns results, trust them exactly — don't inject hardcoded
  // defaults that the user may have intentionally disabled in their OpenCode config.
  // When discovery produced nothing, return empty rather than fabricating modes:
  // OpenCode users can rename or delete any agent, so a hardcoded fallback can
  // validate a mode that does not actually exist (failing later at prompt time).
  return sortOpenCodeModes(filtered);
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

function maxFiniteNumber(left: number | undefined, right: number): number {
  return left === undefined ? right : Math.max(left, right);
}

function assignUsageNumber(usage: AgentUsage, key: keyof AgentUsage, value: number | undefined) {
  if (value !== undefined) {
    usage[key] = value;
  }
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
  // OpenCode lists only overrides; its base model behavior is selected by omitting `variant`.
  const thinkingOptions = rawVariants.length
    ? [
        { id: OPENCODE_DEFAULT_VARIANT_ID, label: "Default", isDefault: true },
        ...rawVariants.map((id) => ({ id, label: id })),
      ]
    : [];

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
          source?: string;
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
    // Providers with source "api" are managed by the OpenCode console/subscription and are
    // usable even though they don't appear in `connected` (which only lists env/config providers).
    if (!connectedProviderIds.has(provider.id) && provider.source !== "api") {
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
  options: { totalCostUsd?: number } = {},
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

  assignUsageNumber(usage, "inputTokens", inputTokens);
  assignUsageNumber(usage, "cachedInputTokens", cacheReadTokens);
  assignUsageNumber(usage, "outputTokens", outputTokens);
  if (totalTokens > 0) {
    usage.contextWindowUsedTokens = totalTokens;
  }
  if (cost !== undefined) {
    usage.totalCostUsd = options.totalCostUsd ?? (usage.totalCostUsd ?? 0) + cost;
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
    if (part.type === "image") {
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
      continue;
    }
    output.push({ type: "text", text: renderPromptAttachmentAsText(part) });
  }
  return output;
}

function buildOpenCodeUserTimelineText(prompt: AgentPromptInput): string {
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

function isOpenCodeDefinitiveSteerRejection(error: unknown, status?: number): boolean {
  if (status === 404) return true;
  const message = toDiagnosticErrorMessage(error).toLowerCase();
  return /session\s+(?:is\s+)?(?:not found|inactive|not active|not running)/.test(message);
}

async function collectOpenCodeImportableSessionsFromSdk(
  client: Pick<OpencodeClient, "experimental">,
  options?: ListImportableSessionsOptions,
): Promise<ImportableProviderSession[]> {
  const limit = options?.limit ?? OPENCODE_PERSISTED_SESSION_LIMIT;
  const sessionListLimit = options?.cwd ? Math.max(limit, OPENCODE_PERSISTED_SESSION_LIMIT) : limit;
  const response = await client.experimental.session.list({
    archived: true,
    roots: true,
    limit: sessionListLimit,
    ...(options?.cwd ? { directory: options.cwd } : {}),
  });

  if (response.error) {
    throw new Error(`Failed to list OpenCode sessions: ${JSON.stringify(response.error)}`);
  }

  const matchesCwd = options?.cwd ? createPathEquivalenceMatcher(options.cwd) : null;
  return (response.data ?? [])
    .filter((session) => !matchesCwd || matchesCwd(session.directory))
    .sort((left, right) => getOpenCodeSessionTimestamp(right) - getOpenCodeSessionTimestamp(left))
    .slice(0, limit)
    .map((session) => ({
      providerHandleId: session.id,
      cwd: session.directory,
      title: normalizeOpenCodeSessionTitle(session.title),
      firstPromptPreview: null,
      lastPromptPreview: null,
      lastActivityAt: new Date(getOpenCodeSessionTimestamp(session)),
    }));
}

function normalizeOpenCodeSessionTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim();
  return normalized ? normalized : null;
}

function getOpenCodeSessionTimestamp(session: OpenCodePersistedSession): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function resolveOpenCodeReplayTimestamp(params: {
  message: { time?: { created?: number; completed?: number } | undefined };
  part?: unknown;
}): string | null {
  const timedPart = params.part as
    | { time?: { start?: number; end?: number } | undefined }
    | undefined;
  const partTimestamp =
    timedPart?.time?.start ??
    timedPart?.time?.end ??
    params.message.time?.created ??
    params.message.time?.completed;
  return normalizeProviderReplayTimestamp(partTimestamp);
}

function buildOpenCodeReplayTimelineEvent(params: {
  item: AgentTimelineItem;
  message: { time?: { created?: number; completed?: number } | undefined };
  part?: unknown;
}): Extract<AgentStreamEvent, { type: "timeline" }> {
  const timestamp = resolveOpenCodeReplayTimestamp({
    message: params.message,
    part: params.part,
  });
  return {
    type: "timeline",
    provider: "opencode",
    item: params.item,
    ...(timestamp ? { timestamp } : {}),
  };
}

function buildOpenCodeReplayPartTimelineEvent(params: {
  part: OpenCodePart;
  message: {
    id: string;
    structured?: unknown;
    time?: { created?: number; completed?: number } | undefined;
  };
}): Extract<AgentStreamEvent, { type: "timeline" }> | null {
  const { part, message } = params;
  if (part.type === "text" && part.text) {
    return buildOpenCodeReplayTimelineEvent({
      item: { type: "assistant_message", text: part.text, messageId: message.id },
      message,
      part,
    });
  }
  if (part.type === "reasoning" && part.text) {
    return buildOpenCodeReplayTimelineEvent({
      item: { type: "reasoning", text: part.text },
      message,
      part,
    });
  }
  if (part.type !== "tool") {
    return null;
  }
  if (isOpenCodeTodoWriteToolPart(part)) {
    const todos = readOpenCodeTodoItemsFromToolPart(part);
    if (!todos) {
      return null;
    }
    return buildOpenCodeReplayTimelineEvent({
      item: mapOpenCodeTodosToTimelineItems(todos),
      message,
      part,
    });
  }
  const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
  if (!parsedToolPart.success || !parsedToolPart.data) {
    return null;
  }
  return buildOpenCodeReplayTimelineEvent({
    item: parsedToolPart.data,
    message,
    part,
  });
}

function isOpenCodeCompactionSummaryMessage(message: OpenCodeMessage): boolean {
  return (
    message.role === "assistant" &&
    (message.summary === true || message.agent === "compaction" || message.mode === "compaction")
  );
}

function findOpenCodeCompactionPart(
  message: OpenCodeSessionMessage,
): Extract<OpenCodePart, { type: "compaction" }> | undefined {
  return message.parts.find(
    (part): part is Extract<OpenCodePart, { type: "compaction" }> => part.type === "compaction",
  );
}

async function readOpenCodeSessionMessagesFromSdk(
  client: Pick<OpencodeClient, "session">,
  session: OpenCodePersistedSession,
  signal?: AbortSignal,
): Promise<OpenCodeSessionMessage[]> {
  const response = await client.session.messages(
    {
      sessionID: session.id,
      directory: session.directory,
    },
    signal ? { signal } : undefined,
  );

  if (response.error || !response.data) {
    return [];
  }

  return filterOpenCodeRevertedMessages(response.data, session.revert);
}

function buildOpenCodeSessionTimeline(
  messages: ReadonlyArray<OpenCodeSessionMessage>,
): AgentTimelineItem[] {
  const timeline: AgentTimelineItem[] = [];
  let hideNextAssistantAfterCompaction = false;

  for (const message of messages) {
    const compactionPart = findOpenCodeCompactionPart(message);
    if (message.info.role === "assistant" && hideNextAssistantAfterCompaction) {
      hideNextAssistantAfterCompaction = false;
      continue;
    }
    if (message.info.role === "user" && !compactionPart) {
      hideNextAssistantAfterCompaction = false;
    }

    timeline.push(...buildOpenCodeReplayTimelineEvents(message).map((event) => event.item));

    if (message.info.role === "user" && compactionPart) {
      timeline.push(
        createCompactionTimelineItem("completed", compactionPart.auto ? "auto" : "manual"),
      );
      hideNextAssistantAfterCompaction = true;
    }
  }

  return timeline;
}

function filterOpenCodeRevertedMessages(
  messages: ReadonlyArray<OpenCodeSessionMessage>,
  revert: OpenCodePersistedSession["revert"] | null | undefined,
): OpenCodeSessionMessage[] {
  if (!revert?.messageID || revert.partID) {
    return [...messages];
  }
  const revertIndex = messages.findIndex((message) => message.info.id === revert.messageID);
  if (revertIndex < 0) {
    return [...messages];
  }
  return messages.slice(0, revertIndex);
}

function resolveOpenCodePersistedSessionModeId(
  session: OpenCodePersistedSession,
  messages: ReadonlyArray<OpenCodeSessionMessage>,
): string | undefined {
  const agent = session.agent ?? messages.map(readOpenCodeMessageAgent).find(Boolean);
  return agent ? (normalizeOpenCodeModeId(agent) ?? undefined) : undefined;
}

function readOpenCodeMessageAgent(message: OpenCodeSessionMessage): string | undefined {
  const agent = message.info.agent;
  return typeof agent === "string" && agent.trim() ? agent : undefined;
}

function resolveOpenCodePersistedSessionModel(
  session: OpenCodePersistedSession,
  messages: ReadonlyArray<OpenCodeSessionMessage>,
): string | undefined {
  if (session.model) {
    return buildOpenCodeModelLookupKey(session.model.providerID, session.model.id);
  }

  const model = messages.map(readOpenCodeMessageModel).find(Boolean);
  return model ? buildOpenCodeModelLookupKey(model.providerID, model.modelID) : undefined;
}

function readOpenCodeMessageModel(
  message: OpenCodeSessionMessage,
): { providerID: string; modelID: string } | undefined {
  const { info } = message;
  if (info.role === "user") {
    return info.model;
  }
  return {
    providerID: info.providerID,
    modelID: info.modelID,
  };
}

function buildOpenCodeReplayTimelineEvents(
  message: OpenCodeSessionMessage,
): Extract<AgentStreamEvent, { type: "timeline" }>[] {
  const { info, parts } = message;
  if (isOpenCodeCompactionSummaryMessage(info)) {
    return [];
  }
  if (info.role === "user") {
    const text = parts
      .filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");

    return text
      ? [
          buildOpenCodeReplayTimelineEvent({
            item: { type: "user_message", text, messageId: info.id },
            message: info,
          }),
        ]
      : [];
  }

  const events: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
  let emittedAssistantText = false;
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      emittedAssistantText = true;
    }
    const event = buildOpenCodeReplayPartTimelineEvent({ part, message: info });
    if (event) {
      events.push(event);
    }
  }

  if (!emittedAssistantText) {
    const text = stringifyStructuredAssistantMessage(info.structured);
    if (text) {
      events.push(
        buildOpenCodeReplayTimelineEvent({
          item: { type: "assistant_message", text, messageId: info.id },
          message: info,
        }),
      );
    }
  }

  return events;
}

export const __openCodeInternals = {
  buildOpenCodePromptParts,
  buildOpenCodeSessionTimeline,
  buildOpenCodeModelContextWindowLookup,
  buildOpenCodeModelDefinition,
  buildOpenCodeModelLookupKey,
  extractOpenCodeModelContextWindow,
  hasNormalizedOpenCodeUsage,
  mergeOpenCodeStepFinishUsage,
  parseOpenCodeModelLookupKey,
  resolveOpenCodeModelLookupKeyFromAssistantMessage,
  resolveOpenCodeSelectedModelContextWindow,
  isSelectableOpenCodeAgent,
  mapOpenCodeAgentToMode,
  resolveOpenCodeHomeDir,
  get OpenCodeAgentSession() {
    return OpenCodeAgentSession;
  },
};

interface OpenCodeAgentClientDeps {
  serverManager?: OpenCodeServerManagerLike;
  createClient?: OpenCodeClientFactory;
  resolveHomeDir?: () => string;
  managedProcesses?: ManagedProcessRegistry;
}

type OpenCodeClientFactory = (options: { baseUrl: string; directory: string }) => OpencodeClient;

function createSdkOpenCodeClient(options: { baseUrl: string; directory: string }): OpencodeClient {
  return createOpencodeClient(options satisfies OpencodeClientConfig & { directory: string });
}

export class OpenCodeAgentClient implements AgentClient {
  readonly provider = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;
  readonly resolveCreateConfig = resolveOpenCodeCreateConfig;
  readonly isCreateConfigUnattended = isOpenCodeCreateConfigUnattended;

  private readonly serverManager: OpenCodeServerManagerLike;
  private readonly createOpenCodeClient: OpenCodeClientFactory;
  private readonly resolveHomeDir: () => string;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly modelContextWindows = new Map<string, number>();

  constructor(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    deps: OpenCodeAgentClientDeps = {},
  ) {
    this.logger = logger.child({ module: "agent", provider: "opencode" });
    this.runtimeSettings = runtimeSettings;
    this.createOpenCodeClient = deps.createClient ?? createSdkOpenCodeClient;
    this.serverManager =
      deps.serverManager ??
      OpenCodeServerManager.getInstance(this.logger, runtimeSettings, {
        managedProcesses: deps.managedProcesses,
        resolveHomeDir: deps.resolveHomeDir,
        createEventSource: ({ serverUrl, processExit }) =>
          new OpenCodeEventConsumer({
            serverUrl,
            processExit,
            createClient: (baseUrl) => this.createOpenCodeClient({ baseUrl, directory: "" }),
          }),
      });
    this.resolveHomeDir = deps.resolveHomeDir ?? resolveOpenCodeHomeDir;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const openCodeConfig = this.assertConfig(config);
    const acquisition = launchContext?.env
      ? await this.serverManager.acquireDedicated(launchContext.env)
      : await this.serverManager.acquireCurrent();
    const { url } = acquisition.server;
    const client = this.createOpenCodeClient({
      baseUrl: url,
      directory: openCodeConfig.cwd,
    });

    try {
      const response = await withTimeout(
        client.session.create({ directory: openCodeConfig.cwd }),
        10_000,
        "OpenCode session.create timed out after 10s",
      );

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
        acquisition.events,
        acquisition.release,
        options?.persistSession,
        launchContext?.agentId,
        url,
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
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const cwd = overrides?.cwd ?? metadata.cwd;
    if (!cwd) {
      throw new Error("OpenCode resume requires the original working directory");
    }

    const config: AgentSessionConfig = {
      ...metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    const openCodeConfig = this.assertConfig(config);
    const registeredServerUrl = getOpenCodeChildSessionServerUrl(handle.sessionId);
    const registeredAcquisition = registeredServerUrl
      ? this.serverManager.acquireExisting(registeredServerUrl)
      : null;
    const acquisition =
      registeredAcquisition ??
      (launchContext?.env
        ? await this.serverManager.acquireDedicated(launchContext.env)
        : await this.serverManager.acquireCurrent());
    const { url } = acquisition.server;
    const client = this.createOpenCodeClient({
      baseUrl: url,
      directory: openCodeConfig.cwd,
    });

    try {
      await this.populateModelContextWindowCache(client, openCodeConfig.cwd);

      return new OpenCodeAgentSession(
        openCodeConfig,
        client,
        handle.sessionId,
        this.logger,
        new Map(this.modelContextWindows),
        acquisition.events,
        acquisition.release,
        undefined,
        launchContext?.agentId,
        url,
        registeredAcquisition !== null,
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
    let acquisition: OpenCodeServerAcquisition | undefined;
    try {
      await runProviderRefreshActivity(context, "server.acquire", async () => {
        acquisition = options.force
          ? await this.serverManager.acquireNew(context?.signal)
          : await this.serverManager.acquireCurrent(context?.signal);
      });
      if (!acquisition) throw new Error("OpenCode server acquisition did not complete");
      context?.signal.throwIfAborted();
      const { url } = acquisition.server;
      const isGlobalCatalog = options.scope === "global";

      // OpenCode treats the catalog directory as a workspace. The global catalog
      // is not a project, so use the neutral OpenCode home instead of user home.
      const directory = isGlobalCatalog ? this.resolveHomeDir() : options.cwd;

      if (isGlobalCatalog) {
        await fs.mkdir(directory, { recursive: true });
        this.logger.debug(
          { directory },
          "opencode catalog refresh: using opencode-home for global provider catalog",
        );
      }

      const client = this.createOpenCodeClient({ baseUrl: url, directory });
      const [models, modes] = await Promise.all([
        this.fetchModelsFromClient(client, directory, context),
        this.fetchModesFromClient(client, directory, context),
      ]);
      return { models, modes };
    } finally {
      await acquisition?.release();
    }
  }

  async listCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const openCodeConfig = this.assertConfig(config);
    const acquisition = await this.serverManager.acquireCurrent();
    const { url } = acquisition.server;
    const client = this.createOpenCodeClient({
      baseUrl: url,
      directory: openCodeConfig.cwd,
    });

    try {
      return await listOpenCodeCommandsFromSdk(client, openCodeConfig.cwd);
    } finally {
      await acquisition.release();
    }
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [buildOpenCodeAutoAcceptFeature(this.assertConfig(config))];
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    const acquisition = await this.serverManager.acquireCurrent();
    const { url } = acquisition.server;
    const client = this.createOpenCodeClient({
      baseUrl: url,
      directory: options?.cwd ?? "",
    });

    try {
      return await collectOpenCodeImportableSessionsFromSdk(client, options);
    } finally {
      await acquisition.release();
    }
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const acquisition = await this.serverManager.acquireCurrent();
    const { url } = acquisition.server;
    const client = this.createOpenCodeClient({
      baseUrl: url,
      directory: input.cwd,
    });

    try {
      const sessionResponse = await client.session.get({
        sessionID: input.providerHandleId,
        directory: input.cwd,
      });
      if (sessionResponse.error || !sessionResponse.data) {
        throw new Error(`Failed to load OpenCode session ${input.providerHandleId}`);
      }
      const session = sessionResponse.data;
      const messages = await readOpenCodeSessionMessagesFromSdk(client, session);
      const modeId = resolveOpenCodePersistedSessionModeId(session, messages);
      const model = resolveOpenCodePersistedSessionModel(session, messages);
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: this.resumeSession.bind(this),
        config: {
          title: normalizeOpenCodeSessionTitle(session.title) ?? undefined,
          ...(modeId ? { modeId } : {}),
          ...(model ? { model } : {}),
        },
      });
    } finally {
      await acquisition.release();
    }
  }

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    await this.setNativeSessionArchived(handle, Date.now());
  }

  async unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    await this.setNativeSessionArchived(handle, null);
  }

  private async setNativeSessionArchived(
    handle: AgentPersistenceHandle,
    archivedAt: number | null,
  ): Promise<void> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    if (!metadata.cwd) {
      throw new Error("OpenCode native archive update requires the original working directory");
    }

    const registeredServerUrl = getOpenCodeChildSessionServerUrl(handle.sessionId);
    const acquisition =
      (registeredServerUrl ? this.serverManager.acquireExisting(registeredServerUrl) : null) ??
      (await this.serverManager.acquireCurrent());
    const client = this.createOpenCodeClient({
      baseUrl: acquisition.server.url,
      directory: metadata.cwd,
    });
    try {
      // OpenCode accepts null to clear the archive timestamp, but this SDK
      // release's generated request type still exposes only number.
      const updateSession = client.session.update.bind(client.session) as (parameters: {
        sessionID: string;
        directory?: string;
        time?: { archived?: number | null };
      }) => ReturnType<typeof client.session.update>;
      const response = readOpenCodeRecord(
        await updateSession({
          sessionID: handle.sessionId,
          directory: metadata.cwd,
          time: { archived: archivedAt },
        }),
      );
      if (response?.error) {
        throw new Error(
          `Failed to ${archivedAt === null ? "unarchive" : "archive"} OpenCode session: ${toDiagnosticErrorMessage(response.error)}`,
        );
      }
    } finally {
      await acquisition.release();
    }
  }

  async isAvailable(): Promise<boolean> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: "opencode",
    });
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  async shutdown(): Promise<void> {
    await this.serverManager.shutdown();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "opencode",
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
        diagnostic: formatProviderDiagnostic("OpenCode", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["opencode"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Auth", value: authValue },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("OpenCode", error),
      };
    }
  }

  private async fetchModelsFromClient(
    client: OpencodeClient,
    directory: string,
    context?: ProviderRefreshContext,
  ): Promise<AgentModelDefinition[]> {
    const response = await runProviderRefreshActivity(context, "provider.list", () =>
      raceProviderRefreshAbort(
        context?.signal,
        openCodeMetadataLimit(() => {
          context?.signal.throwIfAborted();
          return client.provider.list(
            { directory },
            context ? { signal: context.signal } : undefined,
          );
        }),
      ),
    );

    if (response.error) {
      throw new Error(`Failed to fetch OpenCode providers: ${JSON.stringify(response.error)}`);
    }

    const providers = response.data;
    if (!providers) {
      return [];
    }

    const connectedProviderIds = new Set(providers.connected);

    const isAccessible = (provider: { id: string; source: string }): boolean =>
      connectedProviderIds.has(provider.id) || provider.source === "api";

    if (!providers.all.some(isAccessible)) {
      throw new Error(
        "OpenCode has no connected providers. Please authenticate with at least one provider " +
          "(e.g., openai, anthropic), set appropriate environment variables (e.g., OPENAI_API_KEY), " +
          "or log in to OpenCode Go via the console.",
      );
    }

    const models: AgentModelDefinition[] = [];
    const contextWindows = new Map<string, number>();
    for (const provider of providers.all) {
      if (!isAccessible(provider)) {
        continue;
      }

      for (const [modelId, model] of Object.entries(provider.models)) {
        const definition = buildOpenCodeModelDefinition(provider, modelId, model);
        const contextWindowMaxTokens = extractOpenCodeModelContextWindow(model);
        if (contextWindowMaxTokens !== undefined) {
          contextWindows.set(
            buildOpenCodeModelLookupKey(provider.id, modelId),
            contextWindowMaxTokens,
          );
        }
        models.push(definition);
      }
    }

    context?.signal.throwIfAborted();
    this.modelContextWindows.clear();
    for (const [key, value] of contextWindows) this.modelContextWindows.set(key, value);

    return models;
  }

  private async fetchModesFromClient(
    client: OpencodeClient,
    directory: string,
    context?: ProviderRefreshContext,
  ): Promise<AgentMode[]> {
    const response = await runProviderRefreshActivity(context, "app.agents", () =>
      raceProviderRefreshAbort(
        context?.signal,
        openCodeMetadataLimit(() => {
          context?.signal.throwIfAborted();
          return client.app.agents({ directory }, context ? { signal: context.signal } : undefined);
        }),
      ),
    );

    if (response.error || !response.data) {
      // Discovery failed — return an empty list rather than fabricating
      // modes. OpenCode users can rename or delete any agent (including
      // "build"/"plan"), so a hardcoded fallback can validate a mode that
      // does not actually exist, which then fails at prompt time.
      return [];
    }

    const discovered = response.data.filter(isSelectableOpenCodeAgent).map(mapOpenCodeAgentToMode);
    return mergeOpenCodeModes(discovered);
  }
  private assertConfig(config: AgentSessionConfig): OpenCodeAgentConfig {
    if (config.provider !== "opencode") {
      throw new Error(`OpenCodeAgentClient received config for provider '${config.provider}'`);
    }
    const providerOptions = OpenCodeProviderOptionsSchema.parse(config.providerOptions ?? {});
    return normalizeOpenCodeConfig({ ...config, provider: "opencode", providerOptions });
  }

  private async populateModelContextWindowCache(
    client: OpencodeClient,
    cwd: string,
  ): Promise<void> {
    const response = await openCodeMetadataLimit(() => client.provider.list({ directory: cwd }));
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

export interface OpenCodeEventTranslationState {
  sessionId: string;
  cwd?: string;
  messageRoles: Map<string, OpenCodeMessageRole>;
  pendingUserMessageText?: string | null;
  pendingClientMessageId?: string | null;
  pendingSteerSubmissions?: OpenCodePendingSteerSubmission[];
  emittedUserMessageIds?: Set<string>;
  accumulatedUsage: AgentUsage;
  sessionTotalCostUsd?: number;
  materializedParts: Map<string, { messageId: string; emittedText: string; closed: boolean }>;
  emittedStructuredMessageIds: Set<string>;
  compactionSummaryMessageIds: Set<string>;
  emittedCompactionPartIds: Set<string>;
  hydratedMessageFingerprints?: Map<string, string>;
  hydratedPartFingerprints?: Map<string, string>;
  suppressAssistantMessagesUntilIdle?: { active: boolean };
  partTypes: Map<string, string>;
  subAgentsByCallId?: Map<string, OpenCodeSubAgentActivityState>;
  subAgentCallIdByChildSessionId?: Map<string, string>;
  knownChildSessionIds?: Set<string>;
  subagentPresentationByChildId?: Map<string, OpenCodeSubagentPresentationState>;
  modelContextWindowsByModelKey?: ReadonlyMap<string, number>;
  onAssistantModelContextWindowResolved?: (contextWindowMaxTokens: number) => void;
  onMaterializationMismatch?: (diagnostic: {
    partId: string;
    messageId: string;
    kind: "text" | "reasoning";
  }) => void;
}

interface OpenCodePendingSteerSubmission {
  providerMessageId: string;
  text: string;
  clientMessageId: string | null;
}

interface OpenCodeTraceData {
  turnId?: string;
  [key: string]: unknown;
}

type OpenCodeTraceMessage =
  | "provider.opencode.prompt_async.start"
  | "provider.opencode.prompt_async.response"
  | "provider.opencode.prompt_async.throw"
  | "provider.opencode.subscribe.start"
  | "provider.opencode.subscribe.ready"
  | "provider.opencode.stream.eof"
  | "provider.opencode.turn.fail_eof"
  | "provider.opencode.subscribe.error"
  | "provider.opencode.raw_event"
  | "provider.opencode.event.skip"
  | "provider.opencode.parsed_event"
  | "provider.opencode.parsed_event.skip_active"
  | "provider.opencode.event.terminal"
  | "provider.opencode.finish_foreground_turn"
  | "provider.opencode.event_emit";

type OpenCodeToolPartEventPart = Extract<
  Extract<OpenCodeEvent, { type: "message.part.updated" }>["properties"]["part"],
  { type: "tool" }
>;

interface OpenCodeChildSessionInfo {
  id: string;
  parentSessionId: string;
  title?: string;
  directory?: string;
  revert?: OpenCodePersistedSession["revert"];
  agent?: string;
  model?: { id: string; variant?: string };
}

interface OpenCodeSubAgentActivityState {
  toolCall: ToolCallTimelineItem;
  childSessionId?: string;
}

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

async function listOpenCodeCommandsFromSdk(
  client: Pick<OpencodeClient, "command">,
  directory: string,
): Promise<AgentSlashCommand[]> {
  const result = await client.command.list({ directory });
  const commandsByName = new Map(
    OPENCODE_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]),
  );
  if (result.error || !result.data) {
    return Array.from(commandsByName.values());
  }

  for (const cmd of result.data) {
    commandsByName.set(cmd.name, {
      name: cmd.name,
      description: cmd.description ?? "",
      argumentHint: cmd.hints?.length ? cmd.hints.join(" ") : "",
      kind: cmd.source === "skill" ? "skill" : "command",
    });
  }

  return Array.from(commandsByName.values());
}

function readOpenCodeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isOpenCodeTodoWriteToolPart(part: OpenCodeToolPartEventPart | OpenCodePart): boolean {
  return part.type === "tool" && part.tool.trim().toLowerCase() === "todowrite";
}

function readOpenCodeTodoItems(
  value: unknown,
): Array<{ content?: string | null; status?: string | null }> | null {
  if (typeof value === "string") {
    try {
      return readOpenCodeTodoItems(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = readOpenCodeRecord(entry);
      if (!record) {
        return [];
      }
      const content = readNonEmptyString(record.content);
      if (!content) {
        return [];
      }
      return [
        {
          content,
          status: readNonEmptyString(record.status),
        },
      ];
    });
  }
  const record = readOpenCodeRecord(value);
  if (!record) {
    return null;
  }
  return readOpenCodeTodoItems(record.todos);
}

function readOpenCodeTodoItemsFromToolPart(
  part: Extract<OpenCodePart, { type: "tool" }>,
): Array<{ content?: string | null; status?: string | null }> | null {
  const state = readOpenCodeRecord(part.state);
  return (
    readOpenCodeTodoItems(state?.input) ??
    readOpenCodeTodoItems(state?.output) ??
    readOpenCodeTodoItems(state?.metadata)
  );
}

function mapOpenCodeTodosToTimelineItems(
  todos: Array<{ content?: string | null; status?: string | null }>,
): Extract<AgentTimelineItem, { type: "todo" }> {
  return {
    type: "todo",
    items: todos.flatMap((todo) => {
      const text = readNonEmptyString(todo.content);
      if (!text) {
        return [];
      }

      return [
        {
          text,
          status: normalizeOpenCodeTodoStatus(todo.status),
          completed: todo.status === "completed",
        },
      ];
    }),
  };
}

function normalizeOpenCodeTodoStatus(status?: string | null) {
  if (status === "completed") return "completed" as const;
  if (status === "in_progress" || status === "inProgress") return "in_progress" as const;
  return "pending" as const;
}

function createCompactionTimelineItem(
  status: Extract<AgentTimelineItem, { type: "compaction" }>["status"],
  trigger?: Extract<AgentTimelineItem, { type: "compaction" }>["trigger"],
): Extract<AgentTimelineItem, { type: "compaction" }> {
  return {
    type: "compaction",
    status,
    ...(trigger ? { trigger } : {}),
  };
}

const PERMISSION_COMMAND_KEYS = ["command", "cmd", "shellCommand"] as const;
const PERMISSION_CWD_KEYS = ["cwd", "directory", "path", "workdir"] as const;
const PERMISSION_REASON_KEYS = ["reason", "purpose", "description", "message"] as const;
const PERMISSION_TITLE_BY_NAME: Record<string, string> = {
  external_directory: "Access external directory",
  bash: "Run shell command",
  read: "Read files",
  read_file: "Read files",
  write: "Write files",
  write_file: "Write files",
  create_file: "Write files",
  edit: "Edit files",
  apply_patch: "Edit files",
  apply_diff: "Edit files",
};

function toHumanReadablePermissionTitle(permission: string): string {
  const mapped = PERMISSION_TITLE_BY_NAME[permission];
  if (mapped) {
    return mapped;
  }

  const normalized = permission
    .split(/[\s_-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return normalized.length > 0 ? normalized : "Permission request";
}

function readFirstStringFromRecord(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function readPermissionField(
  metadata: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  const direct = readFirstStringFromRecord(metadata, keys);
  if (direct) {
    return direct;
  }

  const nestedInput = readOpenCodeRecord(metadata?.input);
  return readFirstStringFromRecord(nestedInput, keys);
}

function buildOpenCodePermissionInput(params: {
  patterns: string[];
  metadata: Record<string, unknown> | null;
  tool: Record<string, unknown> | null;
  command: string | null;
}): Record<string, unknown> {
  return {
    ...(params.patterns.length > 0 ? { patterns: params.patterns } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.tool ? { tool: params.tool } : {}),
    ...(params.command ? { command: params.command } : {}),
  };
}

function buildOpenCodePermissionDetail(params: {
  permission: string;
  input: Record<string, unknown>;
  command: string | null;
  cwd: string | null;
}): ToolCallDetail {
  if (params.command) {
    return {
      type: "shell",
      command: params.command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
    };
  }

  return {
    type: "unknown",
    input: {
      permission: params.permission,
      ...params.input,
    },
    output: null,
  };
}

function buildOpenCodePermissionDescription(params: {
  reason: string | null;
  patterns: string[];
}): string | undefined {
  const parts: string[] = [];
  if (params.reason) {
    parts.push(params.reason);
  }
  if (params.patterns.length > 0) {
    parts.push(`Scope: ${params.patterns.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" - ") : undefined;
}

export function translateOpenCodeEvent(
  event: OpenCodeEvent,
  state: OpenCodeEventTranslationState,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  switch (event.type) {
    case "session.created":
    case "session.updated":
      appendOpenCodeSessionCreatedOrUpdated(event, state, events);
      break;
    case "session.deleted":
      appendOpenCodeSessionDeleted(event, state, events);
      break;
    case "message.updated":
      appendOpenCodeMessageUpdated(event, state, events);
      break;
    case "message.part.updated":
      appendOpenCodeMessagePartUpdated(event, state, events);
      break;
    case "message.part.delta":
      appendOpenCodeMessagePartDelta(event, state, events);
      break;
    case "permission.asked":
      appendOpenCodePermissionAsked(event, state, events);
      break;
    case "question.asked":
      appendOpenCodeQuestionAsked(event, state, events);
      break;
    case "todo.updated":
      if (event.properties.sessionID === state.sessionId) {
        events.push({
          type: "timeline",
          provider: "opencode",
          item: mapOpenCodeTodosToTimelineItems(event.properties.todos),
        });
      }
      break;
    case "session.compacted":
      if (event.properties.sessionID === state.sessionId) {
        events.push({
          type: "timeline",
          provider: "opencode",
          item: createCompactionTimelineItem("completed"),
        });
      }
      break;
    case "session.idle":
      if (event.properties.sessionID === state.sessionId) {
        resetOpenCodeTurnTrackingState(state);
        events.push({ type: "turn_completed", provider: "opencode", usage: undefined });
      }
      break;
    case "session.error":
      appendOpenCodeSessionError(event, state, events);
      break;
    case "session.status":
      appendOpenCodeSessionStatus(event, state, events);
      break;
  }

  return events;
}

function resetOpenCodeTurnTrackingState(state: OpenCodeEventTranslationState): void {
  state.partTypes.clear();
  state.compactionSummaryMessageIds.clear();
  state.emittedCompactionPartIds.clear();
  if (state.suppressAssistantMessagesUntilIdle) {
    state.suppressAssistantMessagesUntilIdle.active = false;
  }
}

function getOpenCodeSubAgentMaps(state: OpenCodeEventTranslationState): {
  byCallId: Map<string, OpenCodeSubAgentActivityState>;
  callIdByChildSessionId: Map<string, string>;
} {
  state.subAgentsByCallId ??= new Map();
  state.subAgentCallIdByChildSessionId ??= new Map();
  return {
    byCallId: state.subAgentsByCallId,
    callIdByChildSessionId: state.subAgentCallIdByChildSessionId,
  };
}

function getOpenCodeKnownChildSessionIds(state: OpenCodeEventTranslationState): Set<string> {
  state.knownChildSessionIds ??= new Set();
  return state.knownChildSessionIds;
}

function getOpenCodeSubagentPresentationState(
  childSessionId: string,
  state: OpenCodeEventTranslationState,
): OpenCodeSubagentPresentationState {
  state.subagentPresentationByChildId ??= new Map();
  const existing = state.subagentPresentationByChildId.get(childSessionId);
  if (existing) {
    return existing;
  }
  const created: OpenCodeSubagentPresentationState = { facts: {} };
  state.subagentPresentationByChildId.set(childSessionId, created);
  return created;
}

function sumOpenCodeAssistantMessageTokens(
  tokens: OpenCodeAssistantMessage["tokens"] | undefined,
): number {
  if (!tokens) {
    return 0;
  }
  return (
    (readPositiveFiniteNumber(tokens.input) ?? 0) +
    (readPositiveFiniteNumber(tokens.output) ?? 0) +
    (readPositiveFiniteNumber(tokens.reasoning) ?? 0) +
    (readPositiveFiniteNumber(tokens.cache?.read) ?? 0) +
    (readPositiveFiniteNumber(tokens.cache?.write) ?? 0)
  );
}

/** Presentation facts observable on a child assistant message. Token sums only count once the
 * message completes, so partial frames don't publish a shrinking total. */
function readOpenCodeAssistantPresentationFacts(
  info: OpenCodeAssistantMessage,
): OpenCodeSubagentPresentationFacts | null {
  const facts: OpenCodeSubagentPresentationFacts = {};
  const agentName = readNonEmptyString(info.agent);
  if (agentName) {
    facts.agentName = agentName;
  }
  const modelId = readNonEmptyString(info.modelID);
  if (modelId) {
    facts.modelId = modelId;
  }
  const variant = readNonEmptyString(info.variant);
  if (variant) {
    facts.variant = variant;
  }
  if (info.time?.completed !== undefined) {
    const totalTokens = sumOpenCodeAssistantMessageTokens(info.tokens);
    if (totalTokens > 0) {
      facts.totalTokens = totalTokens;
    }
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

function isOpenCodeSessionTrackedByParent(
  sessionId: string,
  state: OpenCodeEventTranslationState,
): boolean {
  return (
    sessionId === state.sessionId ||
    state.knownChildSessionIds?.has(sessionId) === true ||
    state.subAgentCallIdByChildSessionId?.has(sessionId) === true
  );
}

function appendOpenCodeChildSessionDetected(
  child: OpenCodeChildSessionInfo,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
  status: "running" | "completed" | null = "running",
): boolean {
  if (
    child.id === state.sessionId ||
    !isOpenCodeSessionTrackedByParent(child.parentSessionId, state)
  ) {
    return false;
  }

  const knownChildSessionIds = getOpenCodeKnownChildSessionIds(state);
  // Known limitation: detection runs once per child, so a session record that gains `agent`
  // only in a later session.updated is not refreshed here. Assistant-frame facts recover the
  // descriptor title and subtitle via appendChildAssistantPresentationUpsert.
  if (knownChildSessionIds.has(child.id)) {
    return false;
  }

  knownChildSessionIds.add(child.id);
  const presentation = getOpenCodeSubagentPresentationState(child.id, state);
  const subtitle = foldOpenCodeSubagentPresentation(presentation, {
    ...(child.agent ? { agentName: child.agent } : {}),
    ...(child.model?.id ? { modelId: child.model.id } : {}),
    ...(child.model?.variant ? { variant: child.model.variant } : {}),
  });
  const title = claimOpenCodeSubagentFallbackTitle(presentation, child.agent);
  // The row label contract: `description` carries the task (session title fallback), `title`
  // carries the subagent type. Neither gets a placeholder — absent facts render as nothing.
  events.push({
    type: "provider_subagent",
    provider: "opencode",
    event: {
      type: "upsert",
      id: child.id,
      ...(title ? { title } : {}),
      ...(child.title && !presentation.descriptionFromLink ? { description: child.title } : {}),
      ...(status ? { status } : {}),
      ...(child.directory ? { cwd: child.directory } : {}),
      ...(subtitle ? { subtitle } : {}),
    },
  });
  return true;
}

function getOpenCodeSubAgentState(
  callId: string,
  state: OpenCodeEventTranslationState,
  toolCall: ToolCallTimelineItem,
): OpenCodeSubAgentActivityState {
  const maps = getOpenCodeSubAgentMaps(state);
  const existing = maps.byCallId.get(callId);
  if (existing) {
    existing.toolCall = toolCall;
    return existing;
  }

  const created: OpenCodeSubAgentActivityState = {
    toolCall,
  };
  maps.byCallId.set(callId, created);
  return created;
}

function linkOpenCodeSubAgentChildSession(
  activity: OpenCodeSubAgentActivityState,
  childSessionId: string,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  activity.childSessionId = childSessionId;
  const maps = getOpenCodeSubAgentMaps(state);
  maps.callIdByChildSessionId.set(childSessionId, activity.toolCall.callId);
  appendOpenCodeSubAgentLinkPresentation(activity, childSessionId, state, events);
}

/**
 * When a child session ties to a parent `task` tool call, publish the task's identity onto the
 * descriptor: `description` (task input), `title` (subagent type), `toolCallId`. Presentation
 * only — no `status`, so it can never revert a finished child.
 */
function appendOpenCodeSubAgentLinkPresentation(
  activity: OpenCodeSubAgentActivityState,
  childSessionId: string,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const detail = activity.toolCall.detail;
  if (detail.type !== "sub_agent") {
    return;
  }
  const presentation = getOpenCodeSubagentPresentationState(childSessionId, state);
  if (presentation.linkedToolCallId === activity.toolCall.callId) {
    return;
  }
  presentation.linkedToolCallId = activity.toolCall.callId;
  const subAgentType = readNonEmptyString(detail.subAgentType);
  const description = readNonEmptyString(detail.description);
  if (subAgentType) {
    presentation.titleFromLink = true;
    presentation.titleEmitted = true;
  }
  if (description) {
    presentation.descriptionFromLink = true;
  }
  const subtitle = foldOpenCodeSubagentPresentation(
    presentation,
    subAgentType ? { agentName: subAgentType } : {},
  );
  events.push({
    type: "provider_subagent",
    provider: "opencode",
    event: {
      type: "upsert",
      id: childSessionId,
      toolCallId: activity.toolCall.callId,
      ...(subAgentType ? { title: subAgentType } : {}),
      ...(description ? { description } : {}),
      ...(subtitle ? { subtitle } : {}),
    },
  });
}

function buildOpenCodeSubAgentTimelineItem(
  activity: OpenCodeSubAgentActivityState,
): ToolCallTimelineItem {
  const toolCall = activity.toolCall;
  if (toolCall.detail.type !== "sub_agent") {
    return toolCall;
  }
  const childSessionId = activity.childSessionId ?? toolCall.detail.childSessionId;
  return {
    ...toolCall,
    detail: {
      ...toolCall.detail,
      ...(childSessionId ? { childSessionId } : {}),
    },
  };
}

function registerOpenCodeSubAgentToolCall(
  item: ToolCallTimelineItem,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): ToolCallTimelineItem {
  if (item.detail.type !== "sub_agent") {
    return item;
  }
  const activity = getOpenCodeSubAgentState(item.callId, state, item);
  if (item.detail.childSessionId) {
    linkOpenCodeSubAgentChildSession(activity, item.detail.childSessionId, state, events);
  }
  return buildOpenCodeSubAgentTimelineItem(activity);
}

function findOnlyOpenCodeSubAgentWaitingForChild(
  state: OpenCodeEventTranslationState,
): OpenCodeSubAgentActivityState | null {
  const maps = getOpenCodeSubAgentMaps(state);
  const candidates = [...maps.byCallId.values()].filter(
    (activity) =>
      activity.toolCall.status === "running" &&
      activity.toolCall.detail.type === "sub_agent" &&
      !activity.childSessionId,
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function appendOpenCodeToolCallTimelineItem(
  item: ToolCallTimelineItem,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const timelineItem = registerOpenCodeSubAgentToolCall(item, state, events);
  events.push({
    type: "timeline",
    provider: "opencode",
    item: timelineItem,
  });
}

function appendOpenCodeSubAgentChildSessionLinked(
  childSessionId: string,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const activity = findOnlyOpenCodeSubAgentWaitingForChild(state);
  if (!activity) {
    return;
  }
  linkOpenCodeSubAgentChildSession(activity, childSessionId, state, events);
  events.push({
    type: "timeline",
    provider: "opencode",
    item: buildOpenCodeSubAgentTimelineItem(activity),
  });
}

function appendOpenCodeSessionCreatedOrUpdated(
  event: Extract<OpenCodeEvent, { type: "session.created" | "session.updated" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const info = readOpenCodeRecord(event.properties.info);
  if (event.properties.info.id === state.sessionId) {
    const sessionCost = readPositiveFiniteNumber(info?.cost);
    if (sessionCost !== undefined) {
      state.sessionTotalCostUsd = maxFiniteNumber(state.sessionTotalCostUsd, sessionCost);
      state.accumulatedUsage.totalCostUsd = state.sessionTotalCostUsd;
    }
    events.push({
      type: "thread_started",
      sessionId: state.sessionId,
      provider: "opencode",
    });
    return;
  }

  const parentSessionId = readNonEmptyString(info?.parentID) ?? readNonEmptyString(info?.parentId);
  if (parentSessionId) {
    const child = readOpenCodeChildSessionInfo({
      ...info,
      id: event.properties.info.id,
      parentID: parentSessionId,
    });
    if (child) {
      appendOpenCodeChildSessionDetected(child, state, events);
    }
  }
  if (parentSessionId === state.sessionId) {
    appendOpenCodeSubAgentChildSessionLinked(event.properties.info.id, state, events);
  }
}

function appendOpenCodeSessionDeleted(
  event: Extract<OpenCodeEvent, { type: "session.deleted" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const sessionId = event.properties.sessionID;
  if (!isOpenCodeSessionTrackedByParent(sessionId, state)) {
    return;
  }
  state.knownChildSessionIds?.delete(sessionId);
  state.subAgentCallIdByChildSessionId?.delete(sessionId);
  state.subagentPresentationByChildId?.delete(sessionId);
  events.push({
    type: "provider_subagent",
    provider: "opencode",
    event: { type: "remove", id: sessionId },
  });
}

function appendOpenCodeMessageUpdated(
  event: Extract<OpenCodeEvent, { type: "message.updated" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const info = event.properties.info;
  if (info.sessionID !== state.sessionId) {
    return;
  }
  state.messageRoles.set(info.id, info.role);
  if (matchesHydratedFingerprint(state.hydratedMessageFingerprints, info.id, info)) {
    return;
  }
  if (info.role === "user") {
    appendOpenCodeUserMessageUpdated(info, state, events);
    return;
  }
  if (info.role !== "assistant") {
    return;
  }
  if (state.suppressAssistantMessagesUntilIdle?.active) {
    state.compactionSummaryMessageIds.add(info.id);
    return;
  }
  if (isOpenCodeCompactionSummaryMessage(info)) {
    state.compactionSummaryMessageIds.add(info.id);
    return;
  }
  const modelLookupKey = resolveOpenCodeModelLookupKeyFromAssistantMessage(info);
  if (modelLookupKey) {
    const contextWindowMaxTokens = state.modelContextWindowsByModelKey?.get(modelLookupKey);
    if (contextWindowMaxTokens !== undefined) {
      state.onAssistantModelContextWindowResolved?.(contextWindowMaxTokens);
    }
  }
  if (state.emittedStructuredMessageIds.has(info.id) || info.time?.completed === undefined) {
    return;
  }
  const text = stringifyStructuredAssistantMessage(info.structured);
  if (!text) {
    return;
  }
  state.emittedStructuredMessageIds.add(info.id);
  events.push({
    type: "timeline",
    provider: "opencode",
    item: { type: "assistant_message", text, messageId: info.id },
  });
}

function appendOpenCodeUserMessageUpdated(
  info: Extract<OpenCodeMessage, { role: "user" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const pendingSteerIndex = state.pendingSteerSubmissions?.findIndex(
    (submission) => submission.providerMessageId === info.id,
  );
  const pendingSteer =
    pendingSteerIndex !== undefined && pendingSteerIndex >= 0
      ? state.pendingSteerSubmissions?.splice(pendingSteerIndex, 1)[0]
      : undefined;
  const text = pendingSteer?.text ?? state.pendingUserMessageText;
  if (!text || text.trim().length === 0 || state.emittedUserMessageIds?.has(info.id)) {
    return;
  }
  state.emittedUserMessageIds?.add(info.id);
  const clientMessageId = pendingSteer?.clientMessageId ?? state.pendingClientMessageId;
  events.push({
    type: "timeline",
    provider: "opencode",
    item: {
      type: "user_message",
      text,
      messageId: info.id,
      ...(clientMessageId ? { clientMessageId } : {}),
    },
  });
}

function appendOpenCodeMessagePartUpdated(
  event: Extract<OpenCodeEvent, { type: "message.part.updated" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const part = event.properties.part;
  if (part.type === "tool" && isOpenCodeTodoWriteToolPart(part)) {
    return;
  }
  if (part.sessionID !== state.sessionId) {
    return;
  }
  if (matchesHydratedFingerprint(state.hydratedPartFingerprints, part.id, part)) {
    return;
  }
  const messageRole = state.messageRoles.get(part.messageID);
  state.partTypes.set(part.id, part.type);

  if (state.compactionSummaryMessageIds.has(part.messageID)) {
    return;
  }

  if (shouldSuppressOpenCodeAssistantPart(part, messageRole, state)) {
    state.compactionSummaryMessageIds.add(part.messageID);
    return;
  }

  if (part.type === "text") {
    appendOpenCodeTextPart(part, messageRole, state, events);
    return;
  }
  if (part.type === "reasoning") {
    appendOpenCodeReasoningPart(part, state, events);
    return;
  }
  if (part.type === "tool") {
    const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
    if (parsedToolPart.success && parsedToolPart.data) {
      appendOpenCodeToolCallTimelineItem(parsedToolPart.data, state, events);
    }
    return;
  }
  if (part.type === "compaction") {
    if (state.emittedCompactionPartIds.has(part.id)) {
      return;
    }
    state.emittedCompactionPartIds.add(part.id);
    events.push({
      type: "timeline",
      provider: "opencode",
      item: createCompactionTimelineItem("loading", part.auto ? "auto" : "manual"),
    });
    return;
  }
  if (part.type === "step-finish") {
    const stepCost = readPositiveFiniteNumber(part.cost);
    if (stepCost !== undefined) {
      state.sessionTotalCostUsd = (state.sessionTotalCostUsd ?? 0) + stepCost;
    }
    mergeOpenCodeStepFinishUsage(state.accumulatedUsage, part, {
      totalCostUsd: state.sessionTotalCostUsd,
    });
    if (hasNormalizedOpenCodeUsage(state.accumulatedUsage)) {
      events.push({
        type: "usage_updated",
        provider: "opencode",
        usage: { ...state.accumulatedUsage },
      });
    }
  }
}

function shouldSuppressOpenCodeAssistantPart(
  part: Extract<OpenCodeEvent, { type: "message.part.updated" }>["properties"]["part"],
  messageRole: OpenCodeMessageRole | undefined,
  state: OpenCodeEventTranslationState,
): boolean {
  return (
    state.suppressAssistantMessagesUntilIdle?.active === true &&
    part.type === "text" &&
    messageRole !== "user"
  );
}

function appendOpenCodeTextPart(
  part: Extract<
    Extract<OpenCodeEvent, { type: "message.part.updated" }>["properties"]["part"],
    { type: "text" }
  >,
  messageRole: OpenCodeMessageRole | undefined,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (messageRole === "user") {
    if (!part.time?.end || !part.text || state.emittedUserMessageIds?.has(part.messageID)) {
      return;
    }
    state.emittedUserMessageIds?.add(part.messageID);
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "user_message", text: part.text, messageId: part.messageID },
    });
    return;
  }
  if (!part.time?.end) {
    return;
  }
  const materialized = state.materializedParts.get(part.id);
  if (materialized?.closed) return;
  const emittedText = materialized?.messageId === part.messageID ? materialized.emittedText : "";
  if (!part.text.startsWith(emittedText)) {
    state.onMaterializationMismatch?.({
      partId: part.id,
      messageId: part.messageID,
      kind: "text",
    });
    return;
  }
  const suffix = part.text.slice(emittedText.length);
  state.materializedParts.set(part.id, {
    messageId: part.messageID,
    emittedText: part.text,
    closed: true,
  });
  if (suffix) {
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "assistant_message", text: suffix, messageId: part.messageID },
    });
  }
}

function appendOpenCodeReasoningPart(
  part: Extract<
    Extract<OpenCodeEvent, { type: "message.part.updated" }>["properties"]["part"],
    { type: "reasoning" }
  >,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (!part.time.end) {
    return;
  }
  const materialized = state.materializedParts.get(part.id);
  if (materialized?.closed) return;
  const emittedText = materialized?.messageId === part.messageID ? materialized.emittedText : "";
  if (!part.text.startsWith(emittedText)) {
    state.onMaterializationMismatch?.({
      partId: part.id,
      messageId: part.messageID,
      kind: "reasoning",
    });
    return;
  }
  const suffix = part.text.slice(emittedText.length);
  state.materializedParts.set(part.id, {
    messageId: part.messageID,
    emittedText: part.text,
    closed: true,
  });
  if (suffix) {
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "reasoning", text: suffix },
    });
  }
}

function appendOpenCodeMessagePartDelta(
  event: Extract<OpenCodeEvent, { type: "message.part.delta" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const { sessionID, messageID, partID, field, delta } = event.properties;
  if (sessionID !== state.sessionId) {
    return;
  }
  if (!delta || !field) {
    return;
  }
  const messageRole = messageID ? state.messageRoles.get(messageID) : undefined;
  const knownPartType = partID ? state.partTypes.get(partID) : undefined;
  const isReasoning = knownPartType === "reasoning" || field === "reasoning";

  if (messageID && state.compactionSummaryMessageIds.has(messageID)) {
    return;
  }

  if (isReasoning) {
    if (!appendOpenCodeMaterializedDelta(state, partID, messageID, delta)) return;
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "reasoning", text: delta },
    });
    return;
  }
  if (field !== "text") {
    return;
  }
  if (messageRole === "user") {
    return;
  }
  const assistantMessageId = messageID || partID;
  if (!assistantMessageId) {
    return;
  }
  if (state.suppressAssistantMessagesUntilIdle?.active === true) {
    state.compactionSummaryMessageIds.add(assistantMessageId);
    return;
  }
  if (!appendOpenCodeMaterializedDelta(state, partID, assistantMessageId, delta)) return;
  events.push({
    type: "timeline",
    provider: "opencode",
    item: {
      type: "assistant_message",
      text: delta,
      messageId: assistantMessageId,
    },
  });
}

function appendOpenCodeMaterializedDelta(
  state: OpenCodeEventTranslationState,
  partId: string | undefined,
  messageId: string,
  delta: string,
): boolean {
  if (!partId) return true;
  const previous = state.materializedParts.get(partId);
  if (previous?.closed) return false;
  state.materializedParts.set(partId, {
    messageId,
    emittedText: `${previous?.emittedText ?? ""}${delta}`,
    closed: false,
  });
  return true;
}

function appendOpenCodePermissionAsked(
  event: Extract<OpenCodeEvent, { type: "permission.asked" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (!isOpenCodeSessionTrackedByParent(event.properties.sessionID, state)) {
    return;
  }
  const metadata = readOpenCodeRecord(event.properties.metadata);
  const tool = readOpenCodeRecord(event.properties.tool);
  const patterns = Array.isArray(event.properties.patterns)
    ? event.properties.patterns.filter((value): value is string => typeof value === "string")
    : [];
  const command = readPermissionField(metadata, PERMISSION_COMMAND_KEYS);
  const cwd = readPermissionField(metadata, PERMISSION_CWD_KEYS);
  const reason = readPermissionField(metadata, PERMISSION_REASON_KEYS);
  const input = buildOpenCodePermissionInput({ patterns, metadata, tool, command });
  const detail = buildOpenCodePermissionDetail({
    permission: event.properties.permission,
    input,
    command,
    cwd,
  });
  const description = buildOpenCodePermissionDescription({ reason, patterns });

  events.push({
    type: "permission_requested",
    provider: "opencode",
    request: {
      id: event.properties.id,
      provider: "opencode",
      name: event.properties.permission,
      kind: "tool",
      title: toHumanReadablePermissionTitle(event.properties.permission),
      ...(description ? { description } : {}),
      input,
      detail,
      actions: buildOpenCodePermissionActions(),
    },
  });
}

function appendOpenCodeQuestionAsked(
  event: Extract<OpenCodeEvent, { type: "question.asked" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.properties.sessionID !== state.sessionId) {
    return;
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
        allowOther: true,
      },
    ];
  });

  if (questions.length === 0) {
    return;
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
        ...event.properties.tool,
      },
    },
  });
}

function appendOpenCodeSessionError(
  event: Extract<OpenCodeEvent, { type: "session.error" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.properties.sessionID !== state.sessionId) {
    return;
  }
  resetOpenCodeTurnTrackingState(state);
  const error = event.properties.error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "MessageAbortedError"
  ) {
    events.push({
      type: "turn_canceled",
      provider: "opencode",
      reason: "interrupted",
    });
  } else {
    events.push({
      type: "turn_failed",
      provider: "opencode",
      error: toDiagnosticErrorMessage(error),
    });
  }
}

function appendOpenCodeSessionStatus(
  event: Extract<OpenCodeEvent, { type: "session.status" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.properties.sessionID !== state.sessionId) {
    return;
  }
  const { status } = event.properties;
  if (status.type === "idle") {
    resetOpenCodeTurnTrackingState(state);
    events.push({ type: "turn_completed", provider: "opencode", usage: undefined });
    return;
  }
  if (status.type === "retry") {
    // Mirror what opencode's TUI shows: retry attempts are visible activity, not
    // terminal. opencode itself never gives up — it backs off and tries again
    // forever. If we silently swallow these the user sees a spinner with no
    // explanation. Forwarding as a timeline error item is a no-op for old
    // clients (the schema already supports it).
    const message = typeof status.message === "string" ? status.message.trim() : "";
    const text = message
      ? `Provider retry (attempt ${status.attempt}): ${message}`
      : `Provider retry (attempt ${status.attempt})`;
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "error", message: text },
    });
    return;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type OpenCodeTurnState =
  | { status: "idle" }
  | { status: "running"; turnId: string }
  | { status: "stopping"; stop: OpenCodeStop };

type OpenCodeRunnerStatus = "idle" | "busy" | "retry";

/**
 * One in-flight stop of the OpenCode session runner.
 *
 * A stop tracks the run it is stopping: the terminal that run still owes, and
 * the cancellation the caller is still owed. The aborts it issues are tracked by
 * the session instead, because OpenCode's abort is session-scoped rather than
 * turn-scoped and can outlive the stop that issued it. The runner is reusable
 * only once both the terminal and every issued abort have settled.
 */
interface OpenCodeStop {
  /** Foreground turn still owed a cancellation acknowledgement; cleared once emitted. */
  pendingCancellationTurnId: string | null;
  /** Resolves when the canceled run publishes its authoritative terminal. */
  readonly terminal: Deferred<void>;
}

function unwrapOpenCodeGlobalEvent(event: unknown): OpenCodeEvent | null {
  const record = readOpenCodeRecord(event);
  if (!record) {
    return null;
  }

  const payload = readOpenCodeRecord(record.payload);
  if (typeof payload?.type === "string") {
    return payload as unknown as OpenCodeEvent;
  }

  if (typeof record.type === "string") {
    return record as unknown as OpenCodeEvent;
  }

  return null;
}

function getOpenCodeEventSessionId(event: OpenCodeEvent): string | null {
  const properties = readOpenCodeRecord(event.properties);
  const info = readOpenCodeRecord(properties?.info);
  const part = readOpenCodeRecord(properties?.part);
  return (
    readNonEmptyString(properties?.sessionID) ??
    readNonEmptyString(properties?.sessionId) ??
    readNonEmptyString(info?.sessionID) ??
    readNonEmptyString(info?.sessionId) ??
    readNonEmptyString(part?.sessionID) ??
    readNonEmptyString(part?.sessionId) ??
    (event.type === "session.created" || event.type === "session.updated"
      ? readNonEmptyString(info?.id)
      : null)
  );
}

function getOpenCodeRunnerStatusFromEvent(
  event: OpenCodeEvent,
  sessionId: string,
): OpenCodeRunnerStatus | null {
  if (getOpenCodeEventSessionId(event) !== sessionId) {
    return null;
  }
  if (event.type === "session.status") {
    return event.properties.status.type;
  }
  if (event.type === "session.idle" || event.type === "session.error") {
    return "idle";
  }
  return null;
}

function isOpenCodeRunnerActive(status: OpenCodeRunnerStatus): boolean {
  return status === "busy" || status === "retry";
}

function isOpenCodeTerminalEvent(event: OpenCodeEvent, sessionId: string): boolean {
  return getOpenCodeRunnerStatusFromEvent(event, sessionId) === "idle";
}

function isOpenCodeProviderInternalEvent(event: AgentStreamEvent): boolean {
  return event.type === "provider_subagent";
}

function readOpenCodeChildSessionInfo(value: unknown): OpenCodeChildSessionInfo | null {
  const record = readOpenCodeRecord(value);
  if (!record) {
    return null;
  }
  const id = readNonEmptyString(record.id);
  const parentSessionId =
    readNonEmptyString(record.parentID) ?? readNonEmptyString(record.parentId);
  if (!id || !parentSessionId) {
    return null;
  }
  const title = readNonEmptyString(record.title);
  const directory = readNonEmptyString(record.directory);
  const revert = readOpenCodeRecord(record.revert) as OpenCodePersistedSession["revert"] | null;
  const agent = readNonEmptyString(record.agent);
  const model = readOpenCodeChildSessionModel(record.model);
  return {
    id,
    parentSessionId,
    ...(title ? { title } : {}),
    ...(directory ? { directory } : {}),
    ...(revert ? { revert } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
}

function readOpenCodeChildSessionModel(value: unknown): OpenCodeChildSessionInfo["model"] | null {
  const record = readOpenCodeRecord(value);
  const id = readNonEmptyString(record?.id);
  if (!record || !id) {
    return null;
  }
  const variant = readNonEmptyString(record.variant);
  return {
    id,
    ...(variant ? { variant } : {}),
  };
}

function readOpenCodeChildSessionInfosFromResponse(
  response: unknown,
): OpenCodeChildSessionInfo[] | null {
  const record = readOpenCodeRecord(response);
  if (!record || record.error) {
    return null;
  }
  const data = record.data;
  if (!Array.isArray(data)) {
    return null;
  }
  return data.flatMap((item) => {
    const child = readOpenCodeChildSessionInfo(item);
    return child ? [child] : [];
  });
}

async function listOpenCodeChildSessions(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  signal?: AbortSignal,
): Promise<OpenCodeChildSessionInfo[]> {
  const sessionIdResponse = await client.session.children(
    { sessionID: sessionId, directory },
    { signal },
  );
  return readOpenCodeChildSessionInfosFromResponse(sessionIdResponse) ?? [];
}

class OpenCodeAgentSession implements AgentSession {
  readonly provider = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;

  private readonly config: OpenCodeAgentConfig;
  private readonly client: OpencodeClient;
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly modelContextWindowsByModelKey: ReadonlyMap<string, number>;
  private currentMode: string | null = null;
  private autoAcceptEnabled = false;
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private abortController: AbortController | null = null;
  private accumulatedUsage: AgentUsage = {};
  private sessionTotalCostUsd: number | undefined;
  private mcpConfigured = false;
  private mcpSetupPromise: Promise<void> | null = null;
  private messageRoles = new Map<string, OpenCodeMessageRole>();
  private pendingUserMessageText: string | null = null;
  private pendingClientMessageId: string | null = null;
  private pendingSteerSubmissions: OpenCodePendingSteerSubmission[] = [];
  private emittedUserMessageIds = new Set<string>();
  private materializedParts = new Map<
    string,
    { messageId: string; emittedText: string; closed: boolean }
  >();
  private activeDispatchMessageId: string | null = null;
  private emittedStructuredMessageIds = new Set<string>();
  private compactionSummaryMessageIds = new Set<string>();
  private emittedCompactionPartIds = new Set<string>();
  private suppressAssistantMessagesUntilIdle = { active: false };
  private partTypes = new Map<string, string>();
  private availableModesCache: AgentMode[] | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private nextTurnOrdinal = 0;
  private turnState: OpenCodeTurnState = { status: "idle" };
  /**
   * Settlement of every session-scoped abort issued so far. It outlives the stop
   * that issued it because a request still in flight can cancel a replacement
   * run, and a rejection means we never proved the runner stopped.
   */
  private abortSettlement: Promise<void> = Promise.resolve();
  private externalStatusReconciliationStarted = false;
  private runnerStatusRevision = 0;
  private readonly runningToolCalls = new Map<string, ToolCallTimelineItem>();
  private subAgentsByCallId = new Map<string, OpenCodeSubAgentActivityState>();
  private subAgentCallIdByChildSessionId = new Map<string, string>();
  private knownChildSessionIds = new Set<string>();
  private readonly subagentPresentationByChildId = new Map<
    string,
    OpenCodeSubagentPresentationState
  >();
  private readonly childTranslationStates = new Map<string, OpenCodeEventTranslationState>();
  private readonly childSessionCwds = new Map<string, string>();
  private readonly childStatuses = new Map<
    string,
    Extract<Extract<AgentStreamEvent, { type: "provider_subagent" }>["event"], { type: "upsert" }>
  >();
  private readonly pendingPermissionDirectories = new Map<string, string>();
  private childHydrationPromise: Promise<void> | null = null;
  private childHydrationCompleted = false;
  private readonly unrelatedSessionIds = new Set<string>();
  private selectedModelContextWindowMaxTokens: number | undefined;
  private releaseServer: (() => Promise<void>) | null;
  private ingress = Promise.resolve();
  private gapRepairRevision = 0;
  private recoveryAbortController = new AbortController();
  private unsubscribeEvents: (() => void) | null = null;
  private closed = false;
  private readonly persistSession: boolean;
  private deletedFromProvider = false;
  constructor(
    config: OpenCodeAgentConfig,
    client: OpencodeClient,
    sessionId: string,
    logger: Logger,
    modelContextWindowsByModelKey: ReadonlyMap<string, number> = new Map(),
    private readonly events: OpenCodeEventSource = EMPTY_OPENCODE_EVENT_SOURCE,
    releaseServer?: () => Promise<void>,
    persistSession = true,
    private readonly agentId?: string,
    private readonly serverUrl?: string,
    private readonly externallyDriven = false,
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = sessionId;
    this.logger = logger.child({ agentId: this.agentId });
    this.modelContextWindowsByModelKey = modelContextWindowsByModelKey;
    this.currentMode = normalizeOpenCodeModeId(config.modeId);
    this.autoAcceptEnabled = !config.toolPolicy && isOpenCodeAutoAcceptEnabled(config);
    this.releaseServer = releaseServer ?? null;
    this.persistSession = persistSession;
    this.selectedModelContextWindowMaxTokens = this.resolveConfiguredModelContextWindowMaxTokens(
      config.model,
    );
    this.unsubscribeEvents = this.events.subscribe((input) => {
      if ("type" in input && input.type === "server-exited")
        this.recoveryAbortController.abort(input.error);
      this.ingress = this.ingress
        .then(() => this.consumeEventSourceInput(input))
        .catch((error) => {
          this.logger.warn(
            { err: error, sessionId: this.sessionId },
            "OpenCode event ingress failed",
          );
        });
    });
  }

  get id(): string | null {
    return this.sessionId;
  }

  private get activeForegroundTurnId(): string | null {
    return this.turnState.status === "running" ? this.turnState.turnId : null;
  }

  get features(): AgentFeature[] {
    return [buildOpenCodeAutoAcceptFeature(this.config)];
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
    const normalizedThinkingOptionId = normalizeOpenCodeVariantId(thinkingOptionId);
    this.config.thinkingOptionId = normalizedThinkingOptionId ?? undefined;
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

  async interrupt(): Promise<void> {
    const turnId = this.activeForegroundTurnId;
    this.abortController?.abort();
    const abort = this.issueStop(turnId);
    // COMPAT(opencodeSlowAbort): OpenCode 1.14.42+ blocks session.abort until
    // the running tool actually stops, which can be tens of seconds for
    // long-running tools. Cap the wait so the user-visible cancel lands
    // quickly while still giving OpenCode a chance to confirm the abort
    // cleanly. Drop the timeout once upstream returns abort acknowledgement
    // before tool teardown.
    const settledAbort = abort.then(
      () => undefined,
      (error: unknown) => error,
    );
    // Only the cap is tolerated. A settled failure means the runner may still be
    // going, and the caller must hear about it.
    const abortFailure = await withTimeout(settledAbort, 2_000, "OpenCode session.abort").catch(
      (error) => {
        this.logger.warn(
          { err: error, sessionId: this.sessionId, turnId },
          "OpenCode session.abort did not settle within the cancel cap",
        );
        return undefined;
      },
    );
    if (abortFailure !== undefined) {
      throw abortFailure;
    }
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.closed || this.activeForegroundTurnId !== options.expectedTurnId) {
      return { status: "unavailable" };
    }
    if (await this.resolveSlashCommandInvocation(prompt)) {
      return { status: "unavailable" };
    }
    if (this.activeForegroundTurnId !== options.expectedTurnId) {
      return { status: "unavailable" };
    }

    const promptId = createOpenCodeMessageId();
    const pending: OpenCodePendingSteerSubmission = {
      providerMessageId: promptId,
      text: buildOpenCodeUserTimelineText(prompt),
      clientMessageId: options.clientMessageId ?? null,
    };
    this.pendingSteerSubmissions.push(pending);

    const parts = buildOpenCodePromptParts(prompt);
    const systemPrompt = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    const permission = buildOpenCodePermissionRules(
      this.config.providerOptions,
      this.config.toolPolicy,
    );
    const model = this.parseModel(this.config.model);
    const effectiveMode = resolveOpenCodeRuntimeAgentId(this.currentMode);
    const effectiveVariant = this.config.thinkingOptionId ?? undefined;

    try {
      const response = await this.client.session.promptAsync({
        sessionID: this.sessionId,
        directory: this.config.cwd,
        messageID: promptId,
        parts,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(permission ? { permission } : {}),
        ...(model ? { model } : {}),
        ...(effectiveMode ? { agent: effectiveMode } : {}),
        ...(effectiveVariant ? { variant: effectiveVariant } : {}),
      });
      if (response.error) {
        if (
          isOpenCodeDefinitiveSteerRejection(
            response.error,
            (response as unknown as { response?: { status?: number } }).response?.status,
          )
        ) {
          this.removePendingSteerSubmission(promptId);
          return { status: "unavailable" };
        }
        throw new Error(
          `OpenCode steer request failed: ${toDiagnosticErrorMessage(response.error)}`,
        );
      }
      if (options.clearPendingPermissions) {
        await this.clearPendingPermissionsForSteer();
      }
      return { status: "accepted" };
    } catch (error) {
      if (isOpenCodeDefinitiveSteerRejection(error)) {
        this.removePendingSteerSubmission(promptId);
        return { status: "unavailable" };
      }
      throw error;
    }
  }

  private removePendingSteerSubmission(providerMessageId: string): void {
    const index = this.pendingSteerSubmissions.findIndex(
      (submission) => submission.providerMessageId === providerMessageId,
    );
    if (index >= 0) {
      this.pendingSteerSubmissions.splice(index, 1);
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

  async revertBoth(input: { messageId: string }): Promise<void> {
    await revertOpenCodeConversationAndFiles({
      client: this.client,
      sessionId: this.sessionId,
      cwd: this.config.cwd,
      messageId: input.messageId,
    });
  }

  private abortSession(turnId: string | null, reason: string): Promise<void> {
    return this.client.session
      .abort({
        sessionID: this.sessionId,
        directory: this.config.cwd,
      })
      .then((response) => {
        if (response.error) {
          throw new Error(toDiagnosticErrorMessage(response.error));
        }
        return undefined;
      })
      .catch((error) => {
        this.logger.warn(
          { err: error, sessionId: this.sessionId, turnId, reason },
          "OpenCode session.abort rejected",
        );
        throw error;
      });
  }

  /**
   * Gate every runner-affecting operation on the previous stop. OpenCode runs one
   * runner per session and aborts it session-wide, so a replacement may start
   * only once the canceled run published its terminal and our own abort settled.
   * A failed abort never proved the runner stopped, so it fails closed until the
   * next Stop issues a fresh one.
   */
  private async awaitRunnerQuiescence(): Promise<void> {
    const providerIdle = this.waitUntilProviderIdle();
    // A failed abort is decisive on its own, so let it reject this wait without
    // leaving the still-running observation unhandled.
    void providerIdle.catch(() => undefined);
    let observed = this.abortSettlement;
    await Promise.all([observed, providerIdle]);
    // Stop can issue a further abort while we waited, and the settlement is
    // replaced rather than mutated, so drain until what we observed is current.
    while (this.abortSettlement !== observed) {
      observed = this.abortSettlement;
      await observed;
    }
  }

  private async waitUntilProviderIdle(): Promise<void> {
    if (this.turnState.status !== "stopping") return;
    await withTimeout(
      this.observeProviderStopBoundary(this.turnState.stop),
      OPENCODE_PENDING_ABORT_START_TIMEOUT_MS,
      "OpenCode previous turn to stop",
    );
  }

  private async observeProviderStopBoundary(stop: OpenCodeStop): Promise<void> {
    let delayMs = 100;
    while (this.isStopping(stop)) {
      const boundary = await Promise.race([
        stop.terminal.promise.then(() => "terminal" as const),
        waitForOpenCodeStopProbe(delayMs, this.recoveryAbortController.signal).then(
          () => "probe" as const,
        ),
      ]);
      if (boundary === "terminal") return;
      await this.reconcileStopWithProviderStatus(stop);
      delayMs = Math.min(delayMs * 2, OPENCODE_STOP_STATUS_MAX_DELAY_MS);
    }
  }

  private async reconcileStopWithProviderStatus(stop: OpenCodeStop): Promise<void> {
    try {
      if ((await this.readProviderRunnerStatus()) === "idle") {
        this.finishStoppingTurn(stop);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: this.sessionId, turnId: stop.pendingCancellationTurnId },
        "Failed to reconcile the OpenCode stop with provider session status",
      );
    }
  }

  private async readProviderRunnerStatus(): Promise<OpenCodeRunnerStatus> {
    const response = await this.client.session.status(
      { directory: this.config.cwd },
      { signal: this.recoveryAbortController.signal },
    );
    if (response.error) {
      throw new Error(
        `Failed to confirm OpenCode session status: ${toDiagnosticErrorMessage(response.error)}`,
      );
    }
    const statuses = readOpenCodeRecord(response.data);
    if (!statuses) {
      throw new Error("OpenCode returned an invalid session status response");
    }
    const status = readOpenCodeRecord(statuses[this.sessionId]);
    // OpenCode drops idle sessions from the status map entirely.
    if (!status) {
      return "idle";
    }
    const statusType = readNonEmptyString(status.type);
    if (statusType !== "idle" && statusType !== "busy" && statusType !== "retry") {
      throw new Error(`OpenCode returned an unknown session status '${statusType ?? "missing"}'`);
    }
    return statusType;
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("OpenCode session is closed");
    }
    if (this.turnState.status === "running") {
      throw new Error("A foreground turn is already active");
    }
    try {
      await this.awaitRunnerQuiescence();
    } catch (error) {
      this.rethrowRunnerWaitError(error);
    }
    if (this.closed) {
      throw new Error("OpenCode session is closed");
    }
    if (this.turnState.status !== "idle") {
      throw new Error("OpenCode is still stopping the previous turn");
    }

    this.runningToolCalls.clear();
    this.subAgentsByCallId.clear();
    this.subAgentCallIdByChildSessionId.clear();
    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;
    await this.ensureMcpServersConfigured();
    const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
    this.accumulatedUsage = contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};

    const parts = buildOpenCodePromptParts(prompt);
    this.pendingUserMessageText = buildOpenCodeUserTimelineText(prompt);
    this.pendingClientMessageId = options?.clientMessageId ?? null;
    this.suppressAssistantMessagesUntilIdle.active = false;
    const model = this.parseModel(this.config.model);
    const thinkingOptionId = this.config.thinkingOptionId;
    const effectiveVariant = thinkingOptionId ?? undefined;
    const effectiveMode = resolveOpenCodeRuntimeAgentId(this.currentMode);

    try {
      // The stream cannot deliver its first record before OpenCode finished booting, so
      // this wait gets the same budget as server startup instead of a shorter one that
      // fails turns on slow (plugin-heavy or cold) starts.
      await withTimeout(
        this.events.ready(),
        OPENCODE_SERVER_STARTUP_TIMEOUT_MS,
        "OpenCode event stream first record",
      );
    } catch (error) {
      if (this.abortController === turnAbortController) {
        this.abortController = null;
      }
      throw error;
    }

    const turnId = this.createTurnId();
    this.materializedParts.clear();
    this.turnState = { status: "running", turnId };
    this.notifySubscribers({ type: "turn_started", provider: "opencode" }, turnId);

    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    if (slashCommand) {
      if (slashCommand.commandName === "compact" || slashCommand.commandName === "summarize") {
        this.activeDispatchMessageId = null;
        this.suppressAssistantMessagesUntilIdle.active = true;
        void this.client.session
          .summarize({
            sessionID: this.sessionId,
            directory: this.config.cwd,
            ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
          })
          .then((response) => {
            if (response.error) {
              this.suppressAssistantMessagesUntilIdle.active = false;
              this.finishForegroundTurn(
                {
                  type: "turn_failed",
                  provider: "opencode",
                  error: toDiagnosticErrorMessage(response.error),
                },
                turnId,
              );
            }
            return;
          })
          .catch((error) => {
            this.suppressAssistantMessagesUntilIdle.active = false;
            this.finishForegroundTurn(
              {
                type: "turn_failed",
                provider: "opencode",
                error: toDiagnosticErrorMessage(error),
              },
              turnId,
            );
          });
        return { turnId };
      }

      // command() is only dispatch acknowledgement. OpenCode session events are
      // the source of truth for when the command turn becomes idle or fails.
      this.activeDispatchMessageId = createOpenCodeMessageId();
      void this.client.session
        .command({
          sessionID: this.sessionId,
          directory: this.config.cwd,
          command: slashCommand.commandName,
          arguments: slashCommand.args ?? "",
          messageID: this.activeDispatchMessageId,
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(effectiveMode ? { agent: effectiveMode } : {}),
          ...(effectiveVariant ? { variant: effectiveVariant } : {}),
        })
        .then((response) => {
          if (response.error) {
            if (isOpenCodeHeadersTimeoutFailure(response.error)) {
              this.logger.warn(
                {
                  err: response.error,
                  commandName: slashCommand.commandName,
                  turnId,
                },
                "OpenCode slash command hit a header timeout; waiting for SSE terminal event",
              );
              return;
            }
            const errorMsg = toDiagnosticErrorMessage(response.error);
            this.finishForegroundTurn(
              { type: "turn_failed", provider: "opencode", error: errorMsg },
              turnId,
            );
          }
          return;
        })
        .catch((err) => {
          if (isOpenCodeHeadersTimeoutFailure(err)) {
            this.logger.warn(
              {
                err,
                commandName: slashCommand.commandName,
                turnId,
              },
              "OpenCode slash command hit a header timeout; waiting for SSE terminal event",
            );
            return;
          }
          this.finishForegroundTurn(
            { type: "turn_failed", provider: "opencode", error: toDiagnosticErrorMessage(err) },
            turnId,
          );
        });
    } else {
      const dispatchMessageId = createOpenCodeMessageId();
      this.activeDispatchMessageId = dispatchMessageId;
      // Wrap in an async IIFE so a synchronous throw from promptAsync (e.g.
      // SDK input validation) is caught alongside async rejections. A plain
      // `.then().catch()` chain would let a sync throw escape unhandled.
      void (async () => {
        this.traceOpenCode("provider.opencode.prompt_async.start", {
          turnId,
          sessionId: this.sessionId,
          model,
          effectiveMode,
          effectiveVariant,
          partTypes: parts.map((p) => p.type),
        });
        try {
          const systemPrompt = composeSystemPromptParts(
            this.config.systemPrompt,
            this.config.daemonAppendSystemPrompt,
          );
          const permission = buildOpenCodePermissionRules(
            this.config.providerOptions,
            this.config.toolPolicy,
          );
          const promptResponse = await this.client.session.promptAsync({
            sessionID: this.sessionId,
            directory: this.config.cwd,
            messageID: dispatchMessageId,
            parts,
            ...(options?.outputSchema
              ? {
                  format: {
                    type: "json_schema" as const,
                    schema: options.outputSchema as Record<string, unknown>,
                  },
                }
              : {}),
            ...(systemPrompt ? { system: systemPrompt } : {}),
            ...(permission ? { permission } : {}),
            ...(model ? { model } : {}),
            ...(effectiveMode ? { agent: effectiveMode } : {}),
            ...(effectiveVariant ? { variant: effectiveVariant } : {}),
          });
          this.traceOpenCode("provider.opencode.prompt_async.response", {
            turnId,
            hasError: promptResponse.error !== undefined,
            error: promptResponse.error,
            data: promptResponse.data,
          });
          if (promptResponse.error) {
            this.finishForegroundTurn(
              {
                type: "turn_failed",
                provider: "opencode",
                error: toDiagnosticErrorMessage(promptResponse.error),
              },
              turnId,
            );
          }
        } catch (error) {
          this.traceOpenCode("provider.opencode.prompt_async.throw", {
            turnId,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
          });
          this.finishForegroundTurn(
            {
              type: "turn_failed",
              provider: "opencode",
              error: toDiagnosticErrorMessage(error),
            },
            turnId,
          );
        }
      })();
    }

    return { turnId };
  }

  private rethrowRunnerWaitError(error: unknown): never {
    if (this.closed) throw new Error("OpenCode session is closed", { cause: error });
    throw error;
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    this.startExternalStatusReconciliation();
    this.startChildSessionHydration();
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private startExternalStatusReconciliation(): void {
    if (!this.externallyDriven || this.externalStatusReconciliationStarted || this.closed) {
      return;
    }
    this.externalStatusReconciliationStarted = true;
    void this.reconcileExternalRunnerStatus().catch((error) => {
      this.logger.warn(
        { err: error, sessionId: this.sessionId },
        "Failed to reconcile externally driven OpenCode session status",
      );
    });
  }

  private async reconcileExternalRunnerStatus(): Promise<void> {
    await this.events.ready();
    const observedRevision = this.runnerStatusRevision;
    const runnerStatus = await this.readProviderRunnerStatus();
    if (
      this.runnerStatusRevision !== observedRevision ||
      this.turnState.status !== "idle" ||
      !isOpenCodeRunnerActive(runnerStatus)
    ) {
      return;
    }
    this.startAutonomousTurn();
  }

  private startChildSessionHydration(): void {
    if (this.childHydrationPromise) {
      return;
    }
    const hydration = this.hydrateChildSessions()
      .then(() => {
        this.childHydrationCompleted = true;
        return undefined;
      })
      .finally(() => {
        if (this.childHydrationPromise === hydration) {
          this.childHydrationPromise = null;
        }
      });
    this.childHydrationPromise = hydration;
    void hydration.catch((error) => {
      this.logger.warn(
        { err: error, sessionId: this.sessionId },
        "OpenCode child hydration failed",
      );
    });
  }

  private async hydrateChildSessions(recovered = false): Promise<void> {
    const discovered = await this.discoverChildSessions();
    const statusesByDirectory = await this.readChildStatuses(discovered);
    for (const child of discovered) {
      await this.hydrateDiscoveredChild(child, statusesByDirectory, recovered);
    }
  }

  private async discoverChildSessions(): Promise<OpenCodeChildSessionInfo[]> {
    const queue = [{ id: this.sessionId, directory: this.config.cwd }];
    const visited = new Set<string>();
    const discovered: OpenCodeChildSessionInfo[] = [];
    while (queue.length > 0 && visited.size < OPENCODE_CHILD_SESSION_HYDRATION_LIMIT) {
      const parent = queue.shift();
      if (!parent || visited.has(parent.id)) {
        continue;
      }
      visited.add(parent.id);
      const children = await listOpenCodeChildSessions(
        this.client,
        parent.id,
        parent.directory,
        this.recoveryAbortController.signal,
      );
      if (this.closed) return discovered;
      for (const child of children) {
        discovered.push(child);
        if (visited.size + queue.length < OPENCODE_CHILD_SESSION_HYDRATION_LIMIT) {
          queue.push({ id: child.id, directory: child.directory ?? parent.directory });
        }
      }
    }
    return discovered;
  }

  private async readChildStatuses(
    children: OpenCodeChildSessionInfo[],
  ): Promise<Map<string, Record<string, unknown> | null>> {
    const statusesByDirectory = new Map<string, Record<string, unknown> | null>();
    for (const directory of new Set(children.map((child) => child.directory ?? this.config.cwd))) {
      const response = await this.client.session
        .status({ directory }, { signal: this.recoveryAbortController.signal })
        .catch(() => null);
      const record = readOpenCodeRecord(response);
      statusesByDirectory.set(
        directory,
        record && !record.error ? readOpenCodeRecord(record.data) : null,
      );
    }
    return statusesByDirectory;
  }

  private async hydrateDiscoveredChild(
    child: OpenCodeChildSessionInfo,
    statusesByDirectory: Map<string, Record<string, unknown> | null>,
    recovered: boolean,
  ): Promise<void> {
    const directory = child.directory ?? this.config.cwd;
    const snapshot = statusesByDirectory.get(directory) ?? null;
    const status = readOpenCodeRecord(snapshot?.[child.id]);
    const active = snapshot === null || status?.type === "busy" || status?.type === "retry";
    const detectedStatus = active ? "running" : "completed";
    const detectionEvents: AgentStreamEvent[] = [];
    appendOpenCodeChildSessionDetected(
      child,
      this.createTranslationState(),
      detectionEvents,
      recovered ? null : detectedStatus,
    );
    for (const event of detectionEvents) {
      this.recordProviderInternalEvent(event);
      this.notifySubscribers(event, null);
    }
    let messages: OpenCodeSessionMessage[] | null = null;
    try {
      messages = await this.hydrateChildSessionTimeline(child, recovered);
    } catch (error) {
      this.logger.warn(
        { err: error, sessionId: child.id },
        "OpenCode child timeline hydration failed",
      );
    }
    if (!recovered) return;
    const latestAssistant = messages?.findLast((message) => message.info.role === "assistant");
    const recoveredStatus = recoverChildStatus(snapshot !== null, status?.type, latestAssistant);
    if (!recoveredStatus) return;
    const statusEvent: AgentStreamEvent = {
      type: "provider_subagent",
      provider: "opencode",
      event: { type: "upsert", id: child.id, status: recoveredStatus },
    };
    this.recordProviderInternalEvent(statusEvent);
    this.notifySubscribers(statusEvent, null);
  }

  private async hydrateChildSessionTimeline(
    child: OpenCodeChildSessionInfo,
    recovered = false,
  ): Promise<OpenCodeSessionMessage[]> {
    const messages = await readOpenCodeSessionMessagesFromSdk(
      this.client,
      {
        id: child.id,
        directory: child.directory ?? this.config.cwd,
        ...(child.revert ? { revert: child.revert } : {}),
      } as OpenCodePersistedSession,
      this.recoveryAbortController.signal,
    );
    if (recovered) {
      for (const message of messages) {
        await this.consumeOpenCodeStreamEvent({
          rawEvent: {
            directory: child.directory ?? this.config.cwd,
            payload: { type: "message.updated", properties: { info: message.info } },
          },
          eventCount: 0,
        });
        for (const part of message.parts) {
          await this.consumeOpenCodeStreamEvent({
            rawEvent: {
              directory: child.directory ?? this.config.cwd,
              payload: { type: "message.part.updated", properties: { part } },
            },
            eventCount: 0,
          });
        }
      }
      this.emitHydratedChildPresentation(child, messages);
      return messages;
    }
    const translationState = this.getChildTranslationState(child.id);
    let latestReplayedMessage: OpenCodeSessionMessage | null = null;
    for (const message of messages) {
      if (message.info.role === "assistant" && message.info.time?.completed === undefined) {
        continue;
      }
      latestReplayedMessage = message;
      for (const timelineEvent of buildOpenCodeReplayTimelineEvents(message)) {
        const event: AgentStreamEvent = {
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: child.id,
            item: timelineEvent.item,
            ...(timelineEvent.timestamp ? { timestamp: timelineEvent.timestamp } : {}),
          },
        };
        this.recordProviderInternalEvent(event);
        this.notifySubscribers(event, null);
      }
    }
    if (latestReplayedMessage) {
      translationState.hydratedMessageFingerprints?.set(
        latestReplayedMessage.info.id,
        JSON.stringify(latestReplayedMessage.info),
      );
      for (const part of latestReplayedMessage.parts) {
        translationState.hydratedPartFingerprints?.set(part.id, JSON.stringify(part));
      }
    }
    this.emitHydratedChildPresentation(child, messages);
    return messages;
  }

  /**
   * After replaying a historical child, derive presentation facts from the last assistant
   * message (the session record's agent/model were already folded at detection) and publish
   * any missing title plus the updated subtitle once. Presentation-only: no `status`.
   */
  private emitHydratedChildPresentation(
    child: OpenCodeChildSessionInfo,
    messages: ReadonlyArray<OpenCodeSessionMessage>,
  ): void {
    const lastAssistant = messages.findLast(
      (message): message is OpenCodeSessionMessage & { info: OpenCodeAssistantMessage } =>
        message.info.role === "assistant",
    );
    if (!lastAssistant) {
      return;
    }
    const facts = readOpenCodeAssistantPresentationFacts(lastAssistant.info);
    if (!facts) {
      return;
    }
    const presentation = getOpenCodeSubagentPresentationState(
      child.id,
      this.getChildTranslationState(child.id),
    );
    const subtitle = foldOpenCodeSubagentPresentation(presentation, facts);
    const title = claimOpenCodeSubagentFallbackTitle(presentation, facts.agentName);
    if (!subtitle && !title) {
      return;
    }
    const event: AgentStreamEvent = {
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "upsert",
        id: child.id,
        ...(title ? { title } : {}),
        ...(subtitle ? { subtitle } : {}),
      },
    };
    this.recordProviderInternalEvent(event);
    this.notifySubscribers(event, null);
  }

  private recordProviderInternalEvent(event: AgentStreamEvent): void {
    if (event.type !== "provider_subagent") {
      return;
    }
    if (event.event.type === "upsert") {
      this.unrelatedSessionIds.delete(event.event.id);
      if (event.event.cwd) {
        this.childSessionCwds.set(event.event.id, event.event.cwd);
      }
      if (this.serverUrl) {
        registerOpenCodeChildSessionServerUrl(event.event.id, this.serverUrl);
      }
    } else if (event.event.type === "remove") {
      unregisterOpenCodeChildSessionServerUrl(event.event.id);
      this.childTranslationStates.delete(event.event.id);
      this.childSessionCwds.delete(event.event.id);
      this.childStatuses.delete(event.event.id);
      this.subagentPresentationByChildId.delete(event.event.id);
    }
  }

  private async consumeEventSourceInput(input: OpenCodeEventSourceInput): Promise<void> {
    if ("type" in input && input.type === "reconnected") {
      await this.reconcileAfterGap(++this.gapRepairRevision);
      return;
    }
    if ("type" in input && input.type === "server-exited") {
      if (this.turnState.status === "stopping") return this.finishStoppingTurn(this.turnState.stop);
      const turnId = this.activeForegroundTurnId;
      if (turnId) {
        this.finishForegroundTurn(
          { type: "turn_failed", provider: "opencode", error: input.error.message },
          turnId,
        );
      }
      return;
    }
    await this.consumeOpenCodeStreamEvent({ rawEvent: input, eventCount: 0 });
  }

  private async reconcileAfterGap(revision: number, refresh = true, delay = 100): Promise<void> {
    if (revision !== this.gapRepairRevision) return;
    const turnId = this.activeForegroundTurnId;
    const dispatchMessageId = this.activeDispatchMessageId;
    await this.refreshGapScope(refresh);
    if (revision !== this.gapRepairRevision || !turnId) return;
    const runnerStatus = await this.readProviderRunnerStatus().catch(() => null);
    if (revision !== this.gapRepairRevision) return;
    if (runnerStatus === null) {
      this.scheduleGapRepair(revision, delay);
      return;
    }
    if (dispatchMessageId === null) {
      if (runnerStatus === "idle") {
        this.suppressAssistantMessagesUntilIdle.active = false;
        this.finishForegroundTurn({ type: "turn_completed", provider: "opencode" }, turnId);
      }
      return;
    }
    const messages = await readOpenCodeSessionMessagesFromSdk(
      this.client,
      { id: this.sessionId, directory: this.config.cwd } as OpenCodePersistedSession,
      this.recoveryAbortController.signal,
    ).catch(() => null);
    if (revision !== this.gapRepairRevision) return;
    if (messages === null) {
      this.scheduleGapRepair(revision, delay);
      return;
    }
    const boundary = messages.findIndex((message) => message.info.id === dispatchMessageId);
    if (boundary < 0) {
      if (runnerStatus === "idle") {
        this.finishForegroundTurn(
          { type: "turn_failed", provider: "opencode", error: "Active dispatch not found" },
          turnId,
        );
      }
      return;
    }
    for (const message of messages.slice(boundary)) {
      if (revision !== this.gapRepairRevision) return;
      await this.consumeOpenCodeStreamEvent({
        rawEvent: {
          directory: this.config.cwd,
          payload: { type: "message.updated", properties: { info: message.info } },
        },
        eventCount: 0,
      });
      for (const part of message.parts) {
        if (revision !== this.gapRepairRevision) return;
        await this.consumeOpenCodeStreamEvent({
          rawEvent: {
            directory: this.config.cwd,
            payload: { type: "message.part.updated", properties: { part } },
          },
          eventCount: 0,
        });
      }
    }
    if (runnerStatus === "idle" && this.activeForegroundTurnId === turnId) {
      await this.settleRecoveredGap(messages, boundary);
    }
  }

  private async refreshGapScope(refresh: boolean): Promise<void> {
    if (!refresh) return;
    await this.hydrateChildSessions(true).catch(() => undefined);
    await this.reconcileBlockingRequests();
  }

  private async settleRecoveredGap(
    messages: OpenCodeSessionMessage[],
    boundary: number,
  ): Promise<void> {
    const latestAssistant = messages
      .slice(boundary)
      .findLast((message) => message.info.role === "assistant");
    const persistedError =
      latestAssistant && "error" in latestAssistant.info ? latestAssistant.info.error : undefined;
    const payload = persistedError
      ? {
          type: "session.error" as const,
          properties: { sessionID: this.sessionId, error: persistedError },
        }
      : {
          type: "session.status" as const,
          properties: { sessionID: this.sessionId, status: { type: "idle" as const } },
        };
    await this.consumeOpenCodeStreamEvent({
      rawEvent: { directory: this.config.cwd, payload },
      eventCount: 0,
    });
  }

  private scheduleGapRepair(revision: number, delayMs: number): void {
    setTimeout(() => {
      if (revision !== this.gapRepairRevision || this.recoveryAbortController.signal.aborted)
        return;
      const nextDelay = Math.min(delayMs * 2, OPENCODE_STOP_STATUS_MAX_DELAY_MS);
      this.ingress = this.ingress
        .then(() => this.reconcileAfterGap(revision, false, nextDelay))
        .catch(() => undefined);
    }, delayMs).unref();
  }

  private async reconcileBlockingRequests(): Promise<void> {
    const directories = new Set([this.config.cwd, ...this.childSessionCwds.values()]);
    for (const directory of directories) {
      const [permissions, questions] = await Promise.all([
        this.client.permission
          .list({ directory }, { signal: this.recoveryAbortController.signal })
          .catch(() => null),
        this.client.question
          .list({ directory }, { signal: this.recoveryAbortController.signal })
          .catch(() => null),
      ]);
      for (const [kind, response] of [
        ["tool", permissions],
        ["question", questions],
      ] as const) {
        const record = readOpenCodeRecord(response);
        if (!record || record.error || !Array.isArray(record.data)) continue;
        const liveIds = new Set<string>();
        for (const properties of record.data) {
          const propertiesRecord = readOpenCodeRecord(properties);
          const id = readNonEmptyString(propertiesRecord?.id);
          const sessionId = readNonEmptyString(propertiesRecord?.sessionID);
          if (!id || !sessionId || !this.isOwnedSessionId(sessionId)) continue;
          liveIds.add(id);
          await this.consumeOpenCodeStreamEvent({
            rawEvent: {
              directory,
              payload: {
                type: kind === "question" ? "question.asked" : "permission.asked",
                properties,
              },
            },
            eventCount: 0,
          });
        }
        for (const [id, pendingDirectory] of this.pendingPermissionDirectories) {
          const pending = this.pendingPermissions.get(id);
          if (
            pendingDirectory !== directory ||
            liveIds.has(id) ||
            (kind === "question") !== (pending?.kind === "question")
          ) {
            continue;
          }
          this.pendingPermissionDirectories.delete(id);
          this.pendingPermissions.delete(id);
          this.notifySubscribers(
            {
              type: "permission_resolved",
              provider: "opencode",
              requestId: id,
              resolution: { behavior: "allow" },
            },
            null,
          );
        }
      }
    }
  }

  private isOwnedSessionId(sessionId: string): boolean {
    return sessionId === this.sessionId || this.knownChildSessionIds.has(sessionId);
  }

  private async consumeOpenCodeStreamEvent(params: {
    rawEvent: unknown;
    eventCount: number;
  }): Promise<void> {
    const { rawEvent, eventCount } = params;
    let turnId = this.activeForegroundTurnId;
    const event = unwrapOpenCodeGlobalEvent(rawEvent);
    this.traceOpenCode("provider.opencode.raw_event", {
      turnId: turnId ?? undefined,
      n: eventCount,
      type: event?.type,
      rawType: readOpenCodeRecord(rawEvent)?.type,
      directory: readOpenCodeRecord(rawEvent)?.directory,
      rawEvent,
      properties: event?.properties,
    });
    if (!event) {
      return;
    }
    this.observeRunnerStatusEvent(event);
    if (this.discardEventWhileStopping(event, eventCount)) {
      return;
    }
    const translated = await this.translateEvent(event);
    const foregroundEvents: AgentStreamEvent[] = [];
    for (const translatedEvent of translated) {
      if (isOpenCodeProviderInternalEvent(translatedEvent)) {
        this.notifySubscribers(translatedEvent, null);
      } else {
        foregroundEvents.push(translatedEvent);
      }
    }
    if (!turnId && this.shouldStartAutonomousTurn(event)) {
      turnId = this.startAutonomousTurn();
    }
    if (!turnId) {
      this.emitBackgroundPermissionRequests(foregroundEvents);
      this.traceOpenCode("provider.opencode.event.skip", {
        n: eventCount,
        reason: "no_active_turn",
        type: event.type,
      });
      return;
    }
    this.traceOpenCode("provider.opencode.parsed_event", {
      turnId,
      n: eventCount,
      count: foregroundEvents.length,
      types: foregroundEvents.map((t) => t.type),
      events: foregroundEvents,
    });

    for (const e of foregroundEvents) {
      if (this.activeForegroundTurnId !== turnId) {
        this.traceOpenCode("provider.opencode.parsed_event.skip_active", { turnId, type: e.type });
        return;
      }
      if (e.type === "timeline" && e.item.type === "tool_call") {
        this.trackToolCall(e.item);
      }
      const terminalEvent = toTerminalTurnEvent(e);
      if (terminalEvent) {
        this.traceOpenCode("provider.opencode.event.terminal", {
          turnId,
          type: terminalEvent.type,
        });
        this.finishForegroundTurn(terminalEvent, turnId);
        return;
      }
      this.notifySubscribers(e, turnId);
    }
  }

  private discardEventWhileStopping(event: OpenCodeEvent, eventCount: number): boolean {
    if (
      this.turnState.status !== "stopping" ||
      getOpenCodeEventSessionId(event) !== this.sessionId
    ) {
      return false;
    }
    // Residue of the canceled run must not surface as a new turn. Its terminal
    // is the authoritative end of the stop, so anything OpenCode publishes
    // afterwards belongs to a new run by construction and takes the live path.
    if (isOpenCodeTerminalEvent(event, this.sessionId)) {
      this.finishStoppingTurn(this.turnState.stop);
    }
    this.traceOpenCode("provider.opencode.event.skip", {
      n: eventCount,
      reason: "turn_stopping",
      type: event.type,
    });
    return true;
  }

  private emitBackgroundPermissionRequests(events: readonly AgentStreamEvent[]): void {
    for (const event of events) {
      if (event.type === "permission_requested") {
        this.notifySubscribers(event, null);
      }
    }
  }

  private observeRunnerStatusEvent(event: OpenCodeEvent): void {
    if (getOpenCodeRunnerStatusFromEvent(event, this.sessionId) !== null) {
      this.runnerStatusRevision += 1;
    }
  }

  private shouldStartAutonomousTurn(event: OpenCodeEvent): boolean {
    if (this.turnState.status !== "idle") {
      return false;
    }
    // Message records are mutable and can be patched after the runner stops.
    // Only OpenCode's execution status is authoritative for autonomous activity.
    const runnerStatus = getOpenCodeRunnerStatusFromEvent(event, this.sessionId);
    return runnerStatus !== null && isOpenCodeRunnerActive(runnerStatus);
  }

  private startAutonomousTurn(): string {
    const turnId = this.createTurnId();
    this.materializedParts.clear();
    this.turnState = { status: "running", turnId };
    this.runningToolCalls.clear();
    this.subAgentsByCallId.clear();
    this.subAgentCallIdByChildSessionId.clear();
    this.pendingSteerSubmissions = [];
    this.pendingUserMessageText = null;
    this.pendingClientMessageId = null;
    this.activeDispatchMessageId = null;
    this.abortController = null;
    this.notifySubscribers({ type: "turn_started", provider: "opencode" }, turnId);
    return turnId;
  }

  private finishForegroundTurn(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
    turnId: string,
  ): void {
    this.traceOpenCode("provider.opencode.finish_foreground_turn", {
      turnId,
      activeTurnId: this.activeForegroundTurnId,
      type: event.type,
      error: event.type === "turn_failed" ? event.error : undefined,
      reason: event.type === "turn_canceled" ? event.reason : undefined,
    });
    if (this.activeForegroundTurnId !== turnId) {
      return;
    }
    if (event.type === "turn_canceled" || event.type === "turn_failed") {
      this.synthesizeInterruptedToolCalls(turnId);
    } else {
      this.runningToolCalls.clear();
    }
    this.pendingUserMessageText = null;
    this.pendingClientMessageId = null;
    this.pendingSteerSubmissions = [];
    this.turnState = { status: "idle" };
    this.abortController = null;
    this.notifySubscribers(event, turnId);
  }

  private isStopping(stop: OpenCodeStop): boolean {
    return this.turnState.status === "stopping" && this.turnState.stop === stop;
  }

  private issueStop(turnId: string | null): Promise<void> {
    if (this.turnState.status === "stopping") {
      // Stop pressed again during a stop retries that same stop. There is one
      // runner per session, so a second boundary would race the first — and
      // after a failed abort, a fresh one is both the only proof that can still
      // acknowledge the canceled turn and the only way out of fail-closed.
      return this.issueOwnedAbort(this.turnState.stop);
    }
    const stop: OpenCodeStop = {
      pendingCancellationTurnId: turnId,
      terminal: createDeferred<void>(),
    };
    const abort = this.issueOwnedAbort(stop);
    if (turnId) {
      this.synthesizeInterruptedToolCalls(turnId);
      // An idle session has no run to observe, so only abort settlement gates
      // reuse there. A running one also owes the canceled run's terminal.
      this.turnState = { status: "stopping", stop };
    }
    this.pendingUserMessageText = null;
    this.pendingClientMessageId = null;
    this.pendingSteerSubmissions = [];
    this.abortController = null;
    return abort;
  }

  private issueOwnedAbort(stop: OpenCodeStop): Promise<void> {
    const abort = this.runOwnedAbort(stop.pendingCancellationTurnId);
    // Abort is session-scoped, so its settlement is too: an older request lands
    // on the runner whenever the server gets to it, however many stops have come
    // and gone since. Only the newest abort may hold the gate closed, since
    // recovering from a failed one is what pressing Stop again is for.
    const stillInFlight = this.abortSettlement.catch(() => undefined);
    this.abortSettlement = Promise.all([stillInFlight, abort]).then(() => undefined);
    void this.abortSettlement.catch(() => undefined);
    // Cancellation is acknowledged as soon as an owned abort succeeds, or when
    // the provider publishes the canceled run's terminal.
    void abort.then(
      () => this.acknowledgeCancellation(stop),
      () => undefined,
    );
    return abort;
  }

  private acknowledgeCancellation(stop: OpenCodeStop): void {
    const turnId = stop.pendingCancellationTurnId;
    if (!turnId) {
      return;
    }
    stop.pendingCancellationTurnId = null;
    this.notifySubscribers(
      { type: "turn_canceled", provider: "opencode", reason: "interrupted" },
      turnId,
    );
  }

  /**
   * Issues the session-scoped abort for one stop, retrying it once. The stop owns
   * every abort it needs: a detached retry would outlive its own boundary and
   * cancel whichever run happened to be current when it landed.
   */
  private runOwnedAbort(turnId: string | null): Promise<void> {
    // The turn hop also converts a synchronous SDK throw into a rejection.
    return Promise.resolve()
      .then(() => this.abortSession(turnId, "interrupt"))
      .catch((error) => {
        if (this.closed) {
          throw error;
        }
        return this.abortSession(turnId, "stop_retry");
      });
  }

  private finishStoppingTurn(stop: OpenCodeStop): void {
    if (!this.isStopping(stop)) {
      return;
    }
    // Acknowledge before leaving the stopping state so a successor run adopted
    // from the very next event cannot start ahead of the cancellation.
    this.acknowledgeCancellation(stop);
    resetOpenCodeTurnTrackingState(this.createTranslationState());
    const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
    this.accumulatedUsage = contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};
    this.turnState = { status: "idle" };
    stop.terminal.resolve();
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
      const error = { message: "Tool execution aborted" };
      this.notifySubscribers(
        {
          type: "timeline",
          provider: "opencode",
          item: {
            ...item,
            status: "failed",
            error,
            detail:
              item.detail.type === "sub_agent"
                ? {
                    ...item.detail,
                    log: [item.detail.log, error.message]
                      .filter((entry) => entry.trim().length > 0)
                      .join("\n"),
                  }
                : item.detail,
          },
        },
        turnId,
      );
    }
    this.runningToolCalls.clear();
  }

  private notifySubscribers(event: AgentStreamEvent, turnIdOverride?: string | null): void {
    if (this.closed) {
      return;
    }
    if (event.type === "provider_subagent" && event.event.type === "upsert" && event.event.status) {
      if (isDeepStrictEqual(this.childStatuses.get(event.event.id), event.event)) return;
      this.childStatuses.set(event.event.id, structuredClone(event.event));
    }
    const turnId = turnIdOverride === null ? null : (turnIdOverride ?? this.activeForegroundTurnId);
    const tagged = turnId ? { ...event, turnId } : event;
    this.traceOpenCode("provider.opencode.event_emit", {
      turnId: getAgentStreamEventTurnId(tagged),
      event: tagged,
    });
    for (const callback of this.subscribers) {
      try {
        callback(tagged);
      } catch {}
    }
  }

  private createTurnId(): string {
    this.gapRepairRevision += 1;
    return `opencode-turn-${this.nextTurnOrdinal++}`;
  }

  private traceOpenCode(msg: OpenCodeTraceMessage, data: OpenCodeTraceData = {}): void {
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: "opencode",
        sessionId: this.sessionId,
        turnId: data.turnId ?? this.activeForegroundTurnId ?? undefined,
        ...data,
      },
      msg,
    );
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const sessionResponse = await this.client.session.get({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });
    const response = await this.client.session.messages({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });

    if (response.error || !response.data) {
      return;
    }

    const messages = filterOpenCodeRevertedMessages(
      response.data,
      sessionResponse.error ? null : sessionResponse.data?.revert,
    );
    for (const message of messages) {
      for (const event of buildOpenCodeReplayTimelineEvents(message)) {
        yield event;
      }
    }
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    if (this.availableModesCache) {
      return this.availableModesCache;
    }

    const response = await openCodeMetadataLimit(() =>
      this.client.app.agents({
        directory: this.config.cwd,
      }),
    );
    const agents = response.error || !response.data ? [] : response.data;

    const discoveredModes = agents.filter(isSelectableOpenCodeAgent).map(mapOpenCodeAgentToMode);

    this.availableModesCache = mergeOpenCodeModes(discoveredModes);
    return this.availableModesCache;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return await listOpenCodeCommandsFromSdk(this.client, this.config.cwd);
  }

  async setMode(modeId: string): Promise<void> {
    const normalizedModeId = normalizeOpenCodeModeId(modeId);
    if (normalizedModeId === OPENCODE_LEGACY_FULL_ACCESS_MODE_ID) {
      this.currentMode = OPENCODE_BUILD_MODE_ID;
      await this.setFeature(OPENCODE_AUTO_ACCEPT_FEATURE_ID, true);
      return;
    }

    this.currentMode = normalizedModeId;
    this.config.modeId = normalizedModeId ?? undefined;
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId !== OPENCODE_AUTO_ACCEPT_FEATURE_ID) {
      throw new Error(`Unsupported OpenCode feature '${featureId}'`);
    }

    const enabled = value === true;
    this.autoAcceptEnabled = enabled;
    this.config.featureValues = {
      ...this.config.featureValues,
      [OPENCODE_AUTO_ACCEPT_FEATURE_ID]: enabled,
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }

    const directory = this.pendingPermissionDirectories.get(requestId) ?? this.config.cwd;
    if (pending.kind === "question") {
      if (response.behavior === "deny") {
        await this.client.question.reject({
          requestID: requestId,
          directory,
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
          directory,
          answers,
        });
      }

      this.pendingPermissions.delete(requestId);
      this.pendingPermissionDirectories.delete(requestId);
      return;
    }

    const reply = resolveOpenCodePermissionReply(response);
    await this.client.permission.reply({
      requestID: requestId,
      directory,
      reply,
      message: response.behavior === "deny" ? response.message : undefined,
    });

    this.pendingPermissions.delete(requestId);
    this.pendingPermissionDirectories.delete(requestId);
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "opencode",
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
      this.recoveryAbortController.abort();
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = null;
      await this.ingress.catch(() => undefined);
      this.subscribers.clear();
      await abortOpenCodeSession({
        client: this.client,
        sessionId: this.sessionId,
        directory: this.config.cwd,
        logger: this.logger,
      });
      await this.deleteProviderSessionIfEphemeral();
      this.turnState = { status: "idle" };
    } finally {
      await this.releaseServer?.();
      this.releaseServer = null;
    }
  }

  private async deleteProviderSessionIfEphemeral(): Promise<void> {
    if (this.persistSession || this.deletedFromProvider) {
      return;
    }
    this.deletedFromProvider = true;
    try {
      const response = await this.client.session.delete({
        sessionID: this.sessionId,
        directory: this.config.cwd,
      });
      if (response.error) {
        throw new Error(`OpenCode session.delete failed: ${JSON.stringify(response.error)}`);
      }
    } catch (error) {
      this.logger.debug(
        { err: error, sessionId: this.sessionId },
        "Failed to delete non-persistent OpenCode session",
      );
    }
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

  async listMcpServers(): Promise<AgentMcpReport> {
    // Dynamically-added servers only exist once the session has configured them,
    // so make sure that has happened before asking what is connected.
    await this.ensureMcpServersConfigured();
    const response = await this.client.mcp.status({ directory: this.config.cwd });
    // The SDK reports failures through `error` rather than rejecting, so ignoring it
    // would turn any HTTP or API failure into a confident "No MCP servers".
    if (response.error) {
      throw new Error(
        `Failed to read OpenCode MCP status: ${toDiagnosticErrorMessage(response.error)}`,
      );
    }
    const servers: AgentMcpServer[] = [];
    for (const [name, entry] of Object.entries(response.data ?? {})) {
      const server: AgentMcpServer = { name, status: normalizeOpenCodeMcpStatus(entry.status) };
      // `needs_client_registration` carries an error string but is a warning-tone state.
      // The panel draws every error in the danger token, so keeping it here would put a
      // red message beside an amber glyph — two tokens for one status.
      if (server.status === "failed" && "error" in entry && typeof entry.error === "string") {
        server.error = entry.error;
      }
      servers.push(server);
    }
    return { servers, source: "live" };
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
    await Promise.all(
      Object.entries(mcpServers).map(([name, serverConfig]) =>
        this.registerMcpServer(name, toOpenCodeMcpConfig(serverConfig)),
      ),
    );
  }

  private async registerMcpServer(name: string, config: OpenCodeMcpConfig): Promise<void> {
    await this.runMcpOperation("add", name, () =>
      this.client.mcp.add({
        directory: this.config.cwd,
        name,
        config,
      }),
    );
  }

  private async runMcpOperation(
    operation: "add",
    name: string,
    run: () => Promise<{ data?: unknown; error?: unknown }>,
  ): Promise<void> {
    const response = await run();
    const error = response.error ?? readOpenCodeMcpOperationError(response.data, name);
    if (!error) {
      return;
    }

    if (isAlreadyPresentMcpError(error)) {
      return;
    }

    throw new Error(
      `Failed to ${operation} OpenCode MCP server '${name}': ${toDiagnosticErrorMessage(error)}`,
    );
  }

  private createTranslationState(): OpenCodeEventTranslationState {
    return {
      sessionId: this.sessionId,
      cwd: this.config.cwd,
      messageRoles: this.messageRoles,
      pendingUserMessageText: this.pendingUserMessageText,
      pendingClientMessageId: this.pendingClientMessageId,
      pendingSteerSubmissions: this.pendingSteerSubmissions,
      emittedUserMessageIds: this.emittedUserMessageIds,
      accumulatedUsage: this.accumulatedUsage,
      sessionTotalCostUsd: this.sessionTotalCostUsd,
      materializedParts: this.materializedParts,
      emittedStructuredMessageIds: this.emittedStructuredMessageIds,
      compactionSummaryMessageIds: this.compactionSummaryMessageIds,
      emittedCompactionPartIds: this.emittedCompactionPartIds,
      suppressAssistantMessagesUntilIdle: this.suppressAssistantMessagesUntilIdle,
      partTypes: this.partTypes,
      subAgentsByCallId: this.subAgentsByCallId,
      subAgentCallIdByChildSessionId: this.subAgentCallIdByChildSessionId,
      knownChildSessionIds: this.knownChildSessionIds,
      subagentPresentationByChildId: this.subagentPresentationByChildId,
      modelContextWindowsByModelKey: this.modelContextWindowsByModelKey,
      onMaterializationMismatch: (diagnostic) => {
        this.logger.warn(
          { ...diagnostic, sessionId: this.sessionId },
          "OpenCode final part snapshot replaced streamed content",
        );
      },
      onAssistantModelContextWindowResolved: (contextWindowMaxTokens) => {
        this.accumulatedUsage.contextWindowMaxTokens = contextWindowMaxTokens;
        if (!this.config.model) {
          this.selectedModelContextWindowMaxTokens = contextWindowMaxTokens;
        }
      },
    };
  }

  private getChildTranslationState(sessionId: string): OpenCodeEventTranslationState {
    const existing = this.childTranslationStates.get(sessionId);
    if (existing) {
      return existing;
    }
    const state: OpenCodeEventTranslationState = {
      sessionId,
      cwd: this.config.cwd,
      messageRoles: new Map(),
      emittedUserMessageIds: new Set(),
      accumulatedUsage: {},
      materializedParts: new Map(),
      emittedStructuredMessageIds: new Set(),
      compactionSummaryMessageIds: new Set(),
      emittedCompactionPartIds: new Set(),
      hydratedMessageFingerprints: new Map(),
      hydratedPartFingerprints: new Map(),
      suppressAssistantMessagesUntilIdle: { active: false },
      partTypes: new Map(),
      subAgentsByCallId: new Map(),
      subAgentCallIdByChildSessionId: new Map(),
      knownChildSessionIds: new Set(),
      subagentPresentationByChildId: this.subagentPresentationByChildId,
      modelContextWindowsByModelKey: this.modelContextWindowsByModelKey,
      onMaterializationMismatch: (diagnostic) => {
        this.logger.warn(
          { ...diagnostic, sessionId },
          "OpenCode final part snapshot replaced streamed content",
        );
      },
    };
    this.childTranslationStates.set(sessionId, state);
    return state;
  }

  private appendProviderSubagentEvents(event: OpenCodeEvent, translated: AgentStreamEvent[]): void {
    const childSessionId = getOpenCodeEventSessionId(event);
    const isKnownChild = childSessionId && this.knownChildSessionIds.has(childSessionId);
    if (!childSessionId || childSessionId === this.sessionId || !isKnownChild) {
      return;
    }
    translated.push(...this.translateProviderSubagentEvent(childSessionId, event));
  }

  private translateProviderSubagentEvent(
    sessionId: string,
    event: OpenCodeEvent,
  ): AgentStreamEvent[] {
    const translated = translateOpenCodeEvent(event, this.getChildTranslationState(sessionId));
    const events: AgentStreamEvent[] = [];
    let markedRunning = false;
    const markRunning = () => {
      if (markedRunning) return;
      markedRunning = true;
      events.push({
        type: "provider_subagent",
        provider: "opencode",
        event: { type: "upsert", id: sessionId, status: "running" },
      });
    };
    if (event.type === "session.status" && event.properties.status.type === "busy") {
      markRunning();
    }
    this.appendChildAssistantPresentationUpsert(sessionId, event, events);
    for (const childEvent of translated) {
      if (childEvent.type === "timeline") {
        markRunning();
        events.push({
          type: "provider_subagent",
          provider: "opencode",
          event: {
            type: "timeline",
            id: sessionId,
            item: childEvent.item,
            timestamp: childEvent.timestamp,
          },
        });
      } else if (childEvent.type === "turn_started") {
        markRunning();
      } else if (childEvent.type === "turn_completed") {
        events.push({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "upsert", id: sessionId, status: "completed" },
        });
      } else if (childEvent.type === "turn_failed") {
        events.push({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "upsert", id: sessionId, status: "failed" },
        });
      } else if (childEvent.type === "turn_canceled") {
        events.push({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "upsert", id: sessionId, status: "canceled" },
        });
      } else if (
        childEvent.type === "permission_requested" &&
        childEvent.request.kind === "question"
      ) {
        events.push(childEvent);
      }
    }
    return events;
  }

  /**
   * Fold presentation facts (agent, model, variant, completed-message tokens) off a child
   * assistant `message.updated` frame and emit the missing title and/or changed subtitle.
   * Never carries `status`: a presentation upsert must not revert a finished child.
   */
  private appendChildAssistantPresentationUpsert(
    sessionId: string,
    event: OpenCodeEvent,
    events: AgentStreamEvent[],
  ): void {
    if (event.type !== "message.updated") {
      return;
    }
    const info = event.properties.info;
    if (info.sessionID !== sessionId || info.role !== "assistant") {
      return;
    }
    const facts = readOpenCodeAssistantPresentationFacts(info);
    if (!facts) {
      return;
    }
    const presentation = getOpenCodeSubagentPresentationState(
      sessionId,
      this.getChildTranslationState(sessionId),
    );
    const subtitle = foldOpenCodeSubagentPresentation(presentation, facts);
    const title = claimOpenCodeSubagentFallbackTitle(presentation, facts.agentName);
    if (!subtitle && !title) {
      return;
    }
    events.push({
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "upsert",
        id: sessionId,
        ...(title ? { title } : {}),
        ...(subtitle ? { subtitle } : {}),
      },
    });
  }

  private async translateEvent(event: OpenCodeEvent): Promise<AgentStreamEvent[]> {
    const eventSessionId = getOpenCodeEventSessionId(event);
    if (
      event.type !== "session.created" &&
      eventSessionId &&
      eventSessionId !== this.sessionId &&
      !this.knownChildSessionIds.has(eventSessionId) &&
      !this.unrelatedSessionIds.has(eventSessionId)
    ) {
      if (!this.childHydrationCompleted) {
        this.startChildSessionHydration();
        await this.childHydrationPromise?.catch(() => undefined);
      }
      if (!this.knownChildSessionIds.has(eventSessionId)) {
        this.unrelatedSessionIds.add(eventSessionId);
      }
    }
    const translated = translateOpenCodeEvent(event, this.createTranslationState());
    this.appendProviderSubagentEvents(event, translated);

    const events: AgentStreamEvent[] = [];
    if (typeof this.accumulatedUsage.totalCostUsd === "number") {
      this.sessionTotalCostUsd = maxFiniteNumber(
        this.sessionTotalCostUsd,
        this.accumulatedUsage.totalCostUsd,
      );
    }

    for (const translatedEvent of translated) {
      this.recordProviderInternalEvent(translatedEvent);
      if (translatedEvent.type === "permission_requested") {
        const directory =
          (eventSessionId ? this.childSessionCwds.get(eventSessionId) : undefined) ??
          this.config.cwd;
        const autoApproved = await this.tryAutoApproveToolPermission(
          translatedEvent.request,
          directory,
        );
        if (autoApproved) {
          continue;
        }
        this.pendingPermissions.set(translatedEvent.request.id, translatedEvent.request);
        this.pendingPermissionDirectories.set(translatedEvent.request.id, directory);
      }
      if (translatedEvent.type === "turn_completed") {
        if (hasNormalizedOpenCodeUsage(this.accumulatedUsage)) {
          translatedEvent.usage = this.accumulatedUsage;
        }
        const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
        this.accumulatedUsage =
          contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};
      }
      events.push(translatedEvent);
    }

    return events;
  }

  private async tryAutoApproveToolPermission(
    request: AgentPermissionRequest,
    directory: string,
  ): Promise<boolean> {
    if (!this.autoAcceptEnabled || request.kind !== "tool") {
      return false;
    }

    try {
      await this.client.permission.reply({
        requestID: request.id,
        directory,
        reply: "once",
      });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, requestId: request.id },
        "Failed to auto-approve OpenCode tool permission",
      );
      return false;
    }
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
