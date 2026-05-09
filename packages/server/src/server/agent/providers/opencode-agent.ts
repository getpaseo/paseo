import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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
  AgentCreateSessionOptions,
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
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable, isCommandAvailable } from "../../../utils/executable.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { withTimeout } from "../../../utils/promise-timeout.js";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";
import { buildToolCallDisplayModel } from "../../../shared/tool-call-display.js";
import { mapOpencodeToolCall } from "./opencode/tool-call-mapper.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import { runProviderTurn } from "./provider-runner.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";

const OPENCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const OPENCODE_BUILD_MODE_ID = "build";
const OPENCODE_FULL_ACCESS_MODE_ID = "full-access";
const OPENCODE_STORAGE_SESSION_LIMIT = 200;

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
  {
    id: OPENCODE_FULL_ACCESS_MODE_ID,
    label: "Full Access",
    description: "Automatically approves all tool permission prompts for the session",
  },
];

const OpenCodeStoredSessionSchema = z
  .object({
    id: z.string().min(1),
    directory: z.string().min(1),
    title: z.string().nullable().optional(),
    time: z
      .object({
        created: z.number().optional(),
        updated: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

const OpenCodeStoredMessageSchema = z
  .object({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    role: z.string().optional(),
    time: z
      .object({
        created: z.number().optional(),
        completed: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

const OpenCodeStoredPartSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    time: z
      .object({
        start: z.number().optional(),
        end: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

type OpenCodeStoredSession = z.infer<typeof OpenCodeStoredSessionSchema>;
type OpenCodeStoredMessage = z.infer<typeof OpenCodeStoredMessageSchema>;
type OpenCodeStoredPart = z.infer<typeof OpenCodeStoredPartSchema>;

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
const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const OPENCODE_HANDLED_BUILTIN_SLASH_COMMANDS: AgentSlashCommand[] = [
  { name: "compact", description: "Compact the current session", argumentHint: "" },
  { name: "summarize", description: "Compact the current session", argumentHint: "" },
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

async function reconcileOpenCodeSessionClose(params: {
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

  try {
    const response = await client.session.update({
      sessionID: sessionId,
      directory,
      time: { archived: Date.now() },
    });
    if (response.error && !isOpenCodeNotFoundError(response.error)) {
      logger.warn(
        {
          sessionId,
          error: toDiagnosticErrorMessage(response.error),
        },
        "Failed to archive OpenCode session during close",
      );
    }
  } catch (error) {
    logger.warn(
      {
        sessionId,
        error: toDiagnosticErrorMessage(error),
      },
      "Failed to archive OpenCode session during close",
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
    return OPENCODE_BUILD_MODE_ID;
  }
  return trimmed;
}

function resolveOpenCodeRuntimeAgentId(modeId: string | null | undefined): string {
  const normalizedModeId = normalizeOpenCodeModeId(modeId);
  return normalizedModeId === OPENCODE_FULL_ACCESS_MODE_ID
    ? OPENCODE_BUILD_MODE_ID
    : normalizedModeId;
}

function isSelectableOpenCodeAgent(agent: { mode?: string; hidden?: boolean }): boolean {
  return (agent.mode === "primary" || agent.mode === "all") && agent.hidden !== true;
}

function mergeOpenCodeModes(discoveredModes: AgentMode[]): AgentMode[] {
  const modesById = new Map(DEFAULT_MODES.map((mode) => [mode.id, mode]));
  for (const mode of discoveredModes) {
    modesById.set(mode.id, mode);
  }
  return sortOpenCodeModes(Array.from(modesById.values()));
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

function resolveOpenCodeStorageRoot(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome =
    typeof xdgDataHome === "string" && xdgDataHome.trim().length > 0
      ? xdgDataHome
      : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "storage");
}

async function collectOpenCodePersistedAgentsFromStorage(
  storageRoot: string,
  options?: ListPersistedAgentsOptions,
): Promise<PersistedAgentDescriptor[]> {
  const sessions = await readOpenCodeStoredSessions(path.join(storageRoot, "session"));
  const limit = options?.limit ?? OPENCODE_STORAGE_SESSION_LIMIT;
  const candidates = sessions
    .filter((session) => !options?.cwd || session.directory === options.cwd)
    .sort((left, right) => getOpenCodeSessionTimestamp(right) - getOpenCodeSessionTimestamp(left))
    .slice(0, limit);

  return await Promise.all(
    candidates.map((session) => buildOpenCodePersistedAgentDescriptor(storageRoot, session)),
  );
}

async function readOpenCodeStoredSessions(sessionRoot: string): Promise<OpenCodeStoredSession[]> {
  const files = await findJsonFiles(sessionRoot);
  const sessions: OpenCodeStoredSession[] = [];
  for (const file of files) {
    const parsed = await readJsonFile(file, OpenCodeStoredSessionSchema);
    if (parsed) {
      sessions.push(parsed);
    }
  }
  return sessions;
}

async function buildOpenCodePersistedAgentDescriptor(
  storageRoot: string,
  session: OpenCodeStoredSession,
): Promise<PersistedAgentDescriptor> {
  const timeline = await readOpenCodeSessionTimeline(storageRoot, session.id);
  return {
    provider: "opencode",
    sessionId: session.id,
    cwd: session.directory,
    title: normalizeOpenCodeSessionTitle(session.title),
    lastActivityAt: new Date(getOpenCodeSessionTimestamp(session)),
    persistence: {
      provider: "opencode",
      sessionId: session.id,
      nativeHandle: session.id,
      metadata: {
        provider: "opencode",
        cwd: session.directory,
        title: normalizeOpenCodeSessionTitle(session.title),
      },
    },
    timeline,
  };
}

async function readOpenCodeSessionTimeline(
  storageRoot: string,
  sessionId: string,
): Promise<AgentTimelineItem[]> {
  const messageRoot = path.join(storageRoot, "message", sessionId);
  const messageFiles = await findJsonFiles(messageRoot);
  const messages: OpenCodeStoredMessage[] = [];
  for (const file of messageFiles) {
    const parsed = await readJsonFile(file, OpenCodeStoredMessageSchema);
    if (parsed?.sessionID === sessionId) {
      messages.push(parsed);
    }
  }

  const timeline: AgentTimelineItem[] = [];
  for (const message of messages.sort(
    (left, right) => getOpenCodeMessageTimestamp(left) - getOpenCodeMessageTimestamp(right),
  )) {
    const text = await readOpenCodeMessageText(storageRoot, message.id);
    if (!text) {
      continue;
    }
    if (message.role === "user") {
      timeline.push({ type: "user_message", text, messageId: message.id });
    } else if (message.role === "assistant") {
      timeline.push({ type: "assistant_message", text });
    }
  }
  return timeline;
}

async function readOpenCodeMessageText(storageRoot: string, messageId: string): Promise<string> {
  const partRoot = path.join(storageRoot, "part", messageId);
  const partFiles = await findJsonFiles(partRoot);
  const parts: OpenCodeStoredPart[] = [];
  for (const file of partFiles) {
    const parsed = await readJsonFile(file, OpenCodeStoredPartSchema);
    if (parsed?.type === "text" && typeof parsed.text === "string") {
      parts.push(parsed);
    }
  }

  return parts
    .sort((left, right) => getOpenCodePartTimestamp(left) - getOpenCodePartTimestamp(right))
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

async function findJsonFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return findJsonFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

function normalizeOpenCodeSessionTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim();
  return normalized ? normalized : null;
}

function getOpenCodeSessionTimestamp(session: OpenCodeStoredSession): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function getOpenCodeMessageTimestamp(message: OpenCodeStoredMessage): number {
  return message.time?.created ?? message.time?.completed ?? 0;
}

function getOpenCodePartTimestamp(part: OpenCodeStoredPart): number {
  return part.time?.start ?? part.time?.end ?? 0;
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
  reconcileOpenCodeSessionClose,
  resolveOpenCodeModelLookupKeyFromAssistantMessage,
  resolveOpenCodeSelectedModelContextWindow,
  isSelectableOpenCodeAgent,
  get OpenCodeAgentSession() {
    return OpenCodeAgentSession;
  },
};

export class OpenCodeServerManager {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private forcedRefreshPromise: Promise<OpenCodeServerGeneration> | null = null;
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
      void instance?.shutdown();
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async ensureRunning(): Promise<{ port: number; url: string }> {
    const acquisition = await this.acquire({ force: false });
    acquisition.release();
    return acquisition.server;
  }

  async acquire(options: { force: boolean }): Promise<{
    server: { port: number; url: string };
    release: () => void;
  }> {
    const server = options.force
      ? await this.getForcedRefreshServer()
      : await this.getCurrentServer();
    server.refCount += 1;
    let released = false;
    return {
      server: { port: server.port, url: server.url },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        server.refCount -= 1;
        this.cleanupRetiredServers();
      },
    };
  }

  private async getForcedRefreshServer(): Promise<OpenCodeServerGeneration> {
    if (this.forcedRefreshPromise) {
      return this.forcedRefreshPromise;
    }

    this.forcedRefreshPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        return this.getCurrentServer();
      })
      .finally(() => {
        this.forcedRefreshPromise = null;
      });
    return this.forcedRefreshPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      return this.currentServer;
    }

    this.startPromise = this.startServer();
    try {
      const result = await this.startPromise;
      if (!result.retired) {
        this.currentServer = result;
      }
      return result;
    } finally {
      this.startPromise = null;
    }
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      this.cleanupRetiredServers();
    }
  }

  private async startServer(): Promise<OpenCodeServerGeneration> {
    const port = await findAvailablePort();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await resolveProviderCommandPrefix(
      this.runtimeSettings?.command,
      resolveOpenCodeBinary,
    );

    return new Promise((resolve, reject) => {
      const serverProcess = spawnProcess(
        launchPrefix.command,
        [...launchPrefix.args, "serve", "--port", String(port)],
        {
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          ...createProviderEnvSpec({ runtimeSettings: this.runtimeSettings }),
        },
      );

      let started = false;
      let stderrBuffer = "";
      let stdoutBuffer = "";
      const STARTUP_BUFFER_CAP = 8192;
      const appendCapped = (current: string, chunk: string): string => {
        if (current.length >= STARTUP_BUFFER_CAP) {
          return current;
        }
        const remaining = STARTUP_BUFFER_CAP - current.length;
        return current + chunk.slice(0, remaining);
      };
      const buildStartupErrorMessage = (headline: string): string => {
        const sections = [headline];
        const stderrTrimmed = stderrBuffer.trim();
        if (stderrTrimmed.length > 0) {
          sections.push(`stderr: ${stderrTrimmed}`);
        }
        const stdoutTrimmed = stdoutBuffer.trim();
        if (stdoutTrimmed.length > 0) {
          sections.push(`stdout: ${stdoutTrimmed}`);
        }
        return sections.join("\n");
      };
      const timeout = setTimeout(() => {
        if (!started) {
          reject(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, 30_000);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !started) {
          started = true;
          clearTimeout(timeout);
          resolve({
            process: serverProcess,
            port,
            url,
            refCount: 0,
            retired: false,
          });
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.on("error", (error) => {
        clearTimeout(timeout);
        const headline = error instanceof Error ? error.message : String(error);
        reject(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code) => {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)));
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    await Promise.all(servers.map((server) => this.killServer(server)));
    this.currentServer = null;
    this.retiredServers.clear();
  }

  private cleanupRetiredServers(): void {
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        this.retiredServers.delete(server);
        void this.killServer(server);
      }
    }
  }

  private async killServer(server: OpenCodeServerGeneration): Promise<void> {
    if (server.process.killed) {
      return;
    }
    const result = await terminateWithTreeKill(server.process, {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
    }
  }
}

interface OpenCodeServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
}

export class OpenCodeAgentClient implements AgentClient {
  readonly provider = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;

  private readonly serverManager: OpenCodeServerManager;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly modelContextWindows = new Map<string, number>();
  private readonly storageRoot: string;

  constructor(logger: Logger, runtimeSettings?: ProviderRuntimeSettings, storageRoot?: string) {
    this.logger = logger.child({ module: "agent", provider: "opencode" });
    this.runtimeSettings = runtimeSettings;
    this.storageRoot = storageRoot ?? resolveOpenCodeStorageRoot();
    this.serverManager = OpenCodeServerManager.getInstance(this.logger, runtimeSettings);
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const openCodeConfig = this.assertConfig(config);
    const acquisition = await this.serverManager.acquire({ force: false });
    const { url } = acquisition.server;
    const client = createOpencodeClient({
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
        acquisition.release,
        options?.persistSession,
      );
    } catch (error) {
      acquisition.release();
      throw error;
    }
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
    const acquisition = await this.serverManager.acquire({ force: false });
    const { url } = acquisition.server;
    const client = createOpencodeClient({
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
        acquisition.release,
      );
    } catch (error) {
      acquisition.release();
      throw error;
    }
  }

  async listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const acquisition = await this.serverManager.acquire({ force: options.force });
    const { url } = acquisition.server;
    const client = createOpencodeClient({
      baseUrl: url,
      directory: options.cwd,
    });

    try {
      // Background model discovery can be legitimately slow while OpenCode refreshes
      // provider state, so allow longer than turn execution paths.
      const response = await withTimeout(
        client.provider.list({ directory: options.cwd }),
        OPENCODE_PROVIDER_LIST_TIMEOUT_MS,
        `OpenCode provider.list timed out after ${OPENCODE_PROVIDER_LIST_TIMEOUT_MS / 1000}s - server may not be authenticated or connected to any providers`,
      );

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
    } finally {
      acquisition.release();
    }
  }

  async listModes(options: ListModesOptions): Promise<AgentMode[]> {
    const acquisition = await this.serverManager.acquire({ force: options.force });
    const { url } = acquisition.server;
    const directory = options.cwd;
    const client = createOpencodeClient({ baseUrl: url, directory });

    try {
      const response = await withTimeout(
        client.app.agents({ directory }),
        10_000,
        "OpenCode app.agents timed out after 10s",
      );

      if (response.error || !response.data) {
        return DEFAULT_MODES;
      }

      const discovered = response.data.filter(isSelectableOpenCodeAgent).map((agent) => ({
        id: agent.name,
        label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
        description:
          typeof agent.description === "string" && agent.description.trim().length > 0
            ? agent.description.trim()
            : DEFAULT_MODES.find((mode) => mode.id === agent.name)?.description,
      }));

      return mergeOpenCodeModes(discovered);
    } finally {
      acquisition.release();
    }
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    return collectOpenCodePersistedAgentsFromStorage(this.storageRoot, options);
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace") {
      return await isCommandAvailable(command.argv[0]);
    }
    return await isCommandAvailable("opencode");
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
        serverStatus = `Unavailable (${toDiagnosticErrorMessage(error)})`;
      }

      let authValue = "Not checked";
      if (resolvedBinary) {
        try {
          const { stdout, stderr } = await execCommand(resolvedBinary, ["auth", "list"], {
            ...createProviderEnvSpec(),
            timeout: 5_000,
          });
          const text = (stdout.trim() || stderr.trim()).trim();
          authValue = text ? `\n    ${text.replace(/\n/g, "\n    ")}` : "(empty)";
        } catch (error) {
          authValue = `Error - ${toDiagnosticErrorMessage(error)}`;
        }
      }

      if (available) {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
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
            await this.listModes({ cwd: homedir(), force: false });
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
          { label: "Auth", value: authValue },
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

export interface OpenCodeEventTranslationState {
  sessionId: string;
  cwd?: string;
  messageRoles: Map<string, OpenCodeMessageRole>;
  accumulatedUsage: AgentUsage;
  streamedPartKeys: Set<string>;
  emittedStructuredMessageIds: Set<string>;
  /** Tracks the type of each part by ID, learned from message.part.updated events. */
  partTypes: Map<string, string>;
  subAgentsByCallId?: Map<string, OpenCodeSubAgentActivityState>;
  subAgentCallIdByChildSessionId?: Map<string, string>;
  pendingChildToolPartsBySessionId?: Map<string, OpenCodeToolPartEventPart[]>;
  modelContextWindowsByModelKey?: ReadonlyMap<string, number>;
  onAssistantModelContextWindowResolved?: (contextWindowMaxTokens: number) => void;
}

type OpenCodeToolPartEventPart = Extract<
  Extract<OpenCodeEvent, { type: "message.part.updated" }>["properties"]["part"],
  { type: "tool" }
>;

interface OpenCodeSubAgentActionEntry {
  index: number;
  key: string;
  toolName: string;
  summary?: string;
}

interface OpenCodeSubAgentActivityState {
  toolCall: ToolCallTimelineItem;
  actions: OpenCodeSubAgentActionEntry[];
  actionIndexByKey: Map<string, number>;
  nextActionIndex: number;
  childSessionId?: string;
}

const MAX_OPENCODE_SUB_AGENT_ACTIONS = 200;
const MAX_OPENCODE_PENDING_CHILD_TOOL_PARTS = 200;

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
          completed: todo.status === "completed",
        },
      ];
    }),
  };
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
      if (event.properties.sessionID === state.sessionId) {
        resetOpenCodeTurnTrackingState(state);
        events.push({
          type: "turn_failed",
          provider: "opencode",
          error: toDiagnosticErrorMessage(event.properties.error),
        });
      }
      break;
    case "session.status":
      appendOpenCodeSessionStatus(event, state, events);
      break;
  }

  return events;
}

function resetOpenCodeTurnTrackingState(state: OpenCodeEventTranslationState): void {
  state.streamedPartKeys.clear();
  state.partTypes.clear();
}

function getOpenCodeSubAgentMaps(state: OpenCodeEventTranslationState): {
  byCallId: Map<string, OpenCodeSubAgentActivityState>;
  callIdByChildSessionId: Map<string, string>;
  pendingChildToolPartsBySessionId: Map<string, OpenCodeToolPartEventPart[]>;
} {
  state.subAgentsByCallId ??= new Map();
  state.subAgentCallIdByChildSessionId ??= new Map();
  state.pendingChildToolPartsBySessionId ??= new Map();
  return {
    byCallId: state.subAgentsByCallId,
    callIdByChildSessionId: state.subAgentCallIdByChildSessionId,
    pendingChildToolPartsBySessionId: state.pendingChildToolPartsBySessionId,
  };
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
    actions: [],
    actionIndexByKey: new Map(),
    nextActionIndex: 1,
  };
  maps.byCallId.set(callId, created);
  return created;
}

function linkOpenCodeSubAgentChildSession(
  activity: OpenCodeSubAgentActivityState,
  childSessionId: string,
  state: OpenCodeEventTranslationState,
): void {
  activity.childSessionId = childSessionId;
  const maps = getOpenCodeSubAgentMaps(state);
  maps.callIdByChildSessionId.set(childSessionId, activity.toolCall.callId);
}

function buildOpenCodeSubAgentLog(
  detail: Extract<ToolCallDetail, { type: "sub_agent" }>,
  activity: OpenCodeSubAgentActivityState,
): string {
  const actionLog = activity.actions
    .map((action) =>
      action.summary ? `[${action.toolName}] ${action.summary}` : `[${action.toolName}]`,
    )
    .join("\n");
  const parts = [actionLog, detail.log].filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
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
      log: buildOpenCodeSubAgentLog(toolCall.detail, activity),
    },
  };
}

function registerOpenCodeSubAgentToolCall(
  item: ToolCallTimelineItem,
  state: OpenCodeEventTranslationState,
): ToolCallTimelineItem {
  if (item.detail.type !== "sub_agent") {
    return item;
  }
  const activity = getOpenCodeSubAgentState(item.callId, state, item);
  if (item.detail.childSessionId) {
    linkOpenCodeSubAgentChildSession(activity, item.detail.childSessionId, state);
  }
  return buildOpenCodeSubAgentTimelineItem(activity);
}

function bufferOpenCodeSubAgentChildToolPart(
  part: OpenCodeToolPartEventPart,
  state: OpenCodeEventTranslationState,
): void {
  const maps = getOpenCodeSubAgentMaps(state);
  if (maps.byCallId.size === 0) {
    return;
  }
  const totalPending = [...maps.pendingChildToolPartsBySessionId.values()].reduce(
    (total, parts) => total + parts.length,
    0,
  );
  if (totalPending >= MAX_OPENCODE_PENDING_CHILD_TOOL_PARTS) {
    return;
  }
  const pending = maps.pendingChildToolPartsBySessionId.get(part.sessionID) ?? [];
  pending.push(part);
  maps.pendingChildToolPartsBySessionId.set(part.sessionID, pending);
}

function flushOpenCodeSubAgentChildToolParts(
  childSessionId: string,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const maps = getOpenCodeSubAgentMaps(state);
  const pending = maps.pendingChildToolPartsBySessionId.get(childSessionId);
  if (!pending || pending.length === 0) {
    return;
  }
  maps.pendingChildToolPartsBySessionId.delete(childSessionId);
  for (const part of pending) {
    appendOpenCodeSubAgentChildToolPart(part, state, events);
  }
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

function summarizeOpenCodeSubAgentAction(
  item: ToolCallTimelineItem,
  cwd: string | undefined,
): string | undefined {
  const display = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    metadata: item.metadata,
    detail: item.detail,
    cwd,
  });
  return display.summary ?? display.errorText;
}

function appendOpenCodeSubAgentAction(
  activity: OpenCodeSubAgentActivityState,
  item: ToolCallTimelineItem,
  cwd: string | undefined,
): boolean {
  const key = item.callId || `${item.name}:${activity.actions.length}`;
  const existingIndex = activity.actionIndexByKey.get(key);
  const summary = summarizeOpenCodeSubAgentAction(item, cwd);

  if (existingIndex !== undefined) {
    const action = activity.actions[existingIndex];
    if (!action) {
      return false;
    }
    const changed = action.toolName !== item.name || action.summary !== summary;
    action.toolName = item.name;
    if (summary) {
      action.summary = summary;
    } else {
      delete action.summary;
    }
    return changed;
  }

  if (activity.actions.length >= MAX_OPENCODE_SUB_AGENT_ACTIONS) {
    return false;
  }

  activity.actionIndexByKey.set(key, activity.actions.length);
  activity.actions.push({
    index: activity.nextActionIndex,
    key,
    toolName: item.name,
    ...(summary ? { summary } : {}),
  });
  activity.nextActionIndex += 1;
  return true;
}

function appendOpenCodeToolCallTimelineItem(
  item: ToolCallTimelineItem,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const timelineItem = registerOpenCodeSubAgentToolCall(item, state);
  events.push({
    type: "timeline",
    provider: "opencode",
    item: timelineItem,
  });
  if (timelineItem.detail.type === "sub_agent" && timelineItem.detail.childSessionId) {
    flushOpenCodeSubAgentChildToolParts(timelineItem.detail.childSessionId, state, events);
  }
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
  linkOpenCodeSubAgentChildSession(activity, childSessionId, state);
  events.push({
    type: "timeline",
    provider: "opencode",
    item: buildOpenCodeSubAgentTimelineItem(activity),
  });
  flushOpenCodeSubAgentChildToolParts(childSessionId, state, events);
}

function appendOpenCodeSubAgentChildToolPart(
  part: OpenCodeToolPartEventPart,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const maps = getOpenCodeSubAgentMaps(state);
  const parentCallId = maps.callIdByChildSessionId.get(part.sessionID);
  if (!parentCallId) {
    bufferOpenCodeSubAgentChildToolPart(part, state);
    return;
  }
  const activity = maps.byCallId.get(parentCallId);
  if (!activity) {
    return;
  }
  const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
  if (!parsedToolPart.success || !parsedToolPart.data) {
    return;
  }
  if (!appendOpenCodeSubAgentAction(activity, parsedToolPart.data, state.cwd)) {
    return;
  }
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
  if (event.properties.info.id === state.sessionId) {
    events.push({
      type: "thread_started",
      sessionId: state.sessionId,
      provider: "opencode",
    });
    return;
  }

  const info = readOpenCodeRecord(event.properties.info);
  const parentSessionId = readNonEmptyString(info?.parentID) ?? readNonEmptyString(info?.parentId);
  if (parentSessionId === state.sessionId) {
    appendOpenCodeSubAgentChildSessionLinked(event.properties.info.id, state, events);
  }
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
  if (info.role !== "assistant") {
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
    item: { type: "assistant_message", text },
  });
}

function appendOpenCodeMessagePartUpdated(
  event: Extract<OpenCodeEvent, { type: "message.part.updated" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  const part = event.properties.part;
  if (part.sessionID !== state.sessionId) {
    if (part.type === "tool") {
      appendOpenCodeSubAgentChildToolPart(part, state, events);
    }
    return;
  }
  const messageRole = state.messageRoles.get(part.messageID);
  state.partTypes.set(part.id, part.type);

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
    events.push({
      type: "timeline",
      provider: "opencode",
      item: createCompactionTimelineItem("loading", part.auto ? "auto" : "manual"),
    });
    return;
  }
  if (part.type === "step-finish") {
    mergeOpenCodeStepFinishUsage(state.accumulatedUsage, part);
    if (hasNormalizedOpenCodeUsage(state.accumulatedUsage)) {
      events.push({
        type: "usage_updated",
        provider: "opencode",
        usage: { ...state.accumulatedUsage },
      });
    }
  }
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
    return;
  }
  if (!part.time?.end) {
    return;
  }
  const partKey = resolvePartDedupeKey(part, "text");
  if (partKey && state.streamedPartKeys.delete(partKey)) {
    return;
  }
  if (part.text) {
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "assistant_message", text: part.text },
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
  const partKey = resolvePartDedupeKey(part, "reasoning");
  if (partKey && state.streamedPartKeys.delete(partKey)) {
    return;
  }
  if (part.text) {
    events.push({
      type: "timeline",
      provider: "opencode",
      item: { type: "reasoning", text: part.text },
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

  if (isReasoning) {
    if (partID) {
      state.streamedPartKeys.add(`reasoning:${partID}`);
    }
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
  if (partID) {
    state.streamedPartKeys.add(`text:${partID}`);
  }
  events.push({
    type: "timeline",
    provider: "opencode",
    item: { type: "assistant_message", text: delta },
  });
}

function appendOpenCodePermissionAsked(
  event: Extract<OpenCodeEvent, { type: "permission.asked" }>,
  state: OpenCodeEventTranslationState,
  events: AgentStreamEvent[],
): void {
  if (event.properties.sessionID !== state.sessionId) {
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
  // "busy" is transient — no terminal event, no surfaced activity.
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

class OpenCodeAgentSession implements AgentSession {
  readonly provider = "opencode" as const;
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
  private subAgentsByCallId = new Map<string, OpenCodeSubAgentActivityState>();
  private subAgentCallIdByChildSessionId = new Map<string, string>();
  private pendingChildToolPartsBySessionId = new Map<string, OpenCodeToolPartEventPart[]>();
  private selectedModelContextWindowMaxTokens: number | undefined;
  private releaseServer: (() => void) | null;
  private readonly persistSession: boolean;
  private deletedFromProvider = false;
  constructor(
    config: OpenCodeAgentConfig,
    client: OpencodeClient,
    sessionId: string,
    logger: Logger,
    modelContextWindowsByModelKey: ReadonlyMap<string, number> = new Map(),
    releaseServer?: () => void,
    persistSession = true,
  ) {
    this.config = config;
    this.client = client;
    this.sessionId = sessionId;
    this.logger = logger;
    this.modelContextWindowsByModelKey = modelContextWindowsByModelKey;
    this.currentMode = normalizeOpenCodeModeId(config.modeId);
    this.releaseServer = releaseServer ?? null;
    this.persistSession = persistSession;
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
    this.subAgentsByCallId.clear();
    this.subAgentCallIdByChildSessionId.clear();
    this.pendingChildToolPartsBySessionId.clear();
    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;
    await this.ensureMcpServersConfigured();
    const contextWindowMaxTokens = this.resolveSelectedModelContextWindowMaxTokens();
    this.accumulatedUsage = contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {};

    const parts = buildOpenCodePromptParts(prompt);
    const model = this.parseModel(this.config.model);
    const thinkingOptionId = this.config.thinkingOptionId;
    const effectiveVariant = thinkingOptionId ?? undefined;
    const effectiveMode = resolveOpenCodeRuntimeAgentId(this.currentMode);

    const turnId = this.createTurnId();
    this.activeForegroundTurnId = turnId;

    // OpenCode's /event SSE endpoint does NOT replay past events. If we send
    // the prompt before our reader is connected, terminal events fired early
    // by the server (e.g. session.error / session.idle for invalid model or
    // mode) are missed and the turn hangs forever. Wait for the subscription
    // to be established before sending anything.
    const subscriptionReady = createDeferred<void>();
    void this.consumeEventStream(turnId, turnAbortController, subscriptionReady);
    try {
      await subscriptionReady.promise;
    } catch {
      // consumeEventStream already finished the turn with the subscription error.
      return { turnId };
    }

    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    if (slashCommand) {
      if (slashCommand.commandName === "compact" || slashCommand.commandName === "summarize") {
        void this.client.session
          .summarize({
            sessionID: this.sessionId,
            directory: this.config.cwd,
            ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
          })
          .then((response) => {
            if (response.error) {
              this.finishForegroundTurn(
                {
                  type: "turn_failed",
                  provider: "opencode",
                  error: toDiagnosticErrorMessage(response.error),
                },
                turnId,
              );
            } else {
              this.finishForegroundTurn(
                { type: "turn_completed", provider: "opencode", usage: undefined },
                turnId,
              );
            }
            return;
          })
          .catch((error) => {
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
          } else {
            this.finishForegroundTurn(
              { type: "turn_completed", provider: "opencode", usage: undefined },
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
      // Wrap in an async IIFE so a synchronous throw from promptAsync (e.g.
      // SDK input validation) is caught alongside async rejections. A plain
      // `.then().catch()` chain would let a sync throw escape unhandled.
      void (async () => {
        try {
          const promptResponse = await this.client.session.promptAsync({
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

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async consumeEventStream(
    turnId: string,
    turnAbortController: AbortController,
    subscriptionReady: Deferred<void>,
  ): Promise<void> {
    try {
      const result = await this.client.event.subscribe(
        { directory: this.config.cwd },
        { signal: turnAbortController.signal, sseMaxRetryAttempts: 0 },
      );
      subscriptionReady.resolve();

      for await (const event of result.stream) {
        if (turnAbortController.signal.aborted || this.activeForegroundTurnId !== turnId) {
          break;
        }

        const translated = await this.translateEvent(event);
        for (const e of translated) {
          if (this.activeForegroundTurnId !== turnId) {
            return;
          }
          if (e.type === "timeline" && e.item.type === "tool_call") {
            this.trackToolCall(e.item);
          }
          const terminalEvent = toTerminalTurnEvent(e);
          if (terminalEvent) {
            this.finishForegroundTurn(terminalEvent, turnId);
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
      subscriptionReady.reject(error);
      if (!turnAbortController.signal.aborted && this.activeForegroundTurnId === turnId) {
        this.finishForegroundTurn(
          {
            type: "turn_failed",
            provider: "opencode",
            error: toDiagnosticErrorMessage(error),
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
          if (part.type === "text" && part.text) {
            emittedAssistantText = true;
            yield {
              type: "timeline",
              provider: "opencode",
              item: { type: "assistant_message", text: part.text },
            };
            continue;
          }
          if (part.type === "reasoning" && part.text) {
            yield {
              type: "timeline",
              provider: "opencode",
              item: { type: "reasoning", text: part.text },
            };
            continue;
          }
          if (part.type !== "tool") {
            continue;
          }
          const parsedToolPart = OpencodeToolPartToTimelineItemSchema.safeParse(part);
          if (parsedToolPart.success && parsedToolPart.data) {
            yield {
              type: "timeline",
              provider: "opencode",
              item: parsedToolPart.data,
            };
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
    const agents = response.error || !response.data ? [] : response.data;

    const discoveredModes = agents.filter(isSelectableOpenCodeAgent).map((agent) => ({
      id: agent.name,
      label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
      description:
        typeof agent.description === "string" && agent.description.trim().length > 0
          ? agent.description.trim()
          : DEFAULT_MODES.find((mode) => mode.id === agent.name)?.description,
    }));

    this.availableModesCache = mergeOpenCodeModes(discoveredModes);
    return this.availableModesCache;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const result = await this.client.command.list({
      directory: this.config.cwd,
    });

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
      });
    }
    return Array.from(commandsByName.values());
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
    try {
      this.abortController?.abort();
      await reconcileOpenCodeSessionClose({
        client: this.client,
        sessionId: this.sessionId,
        directory: this.config.cwd,
        logger: this.logger,
      });
      await this.deleteProviderSessionIfEphemeral();
      this.subscribers.clear();
      this.activeForegroundTurnId = null;
    } finally {
      this.releaseServer?.();
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
      `Failed to ${operation} OpenCode MCP server '${name}': ${toDiagnosticErrorMessage(error)}`,
    );
  }

  private async translateEvent(event: OpenCodeEvent): Promise<AgentStreamEvent[]> {
    const translated = translateOpenCodeEvent(event, {
      sessionId: this.sessionId,
      cwd: this.config.cwd,
      messageRoles: this.messageRoles,
      accumulatedUsage: this.accumulatedUsage,
      streamedPartKeys: this.streamedPartKeys,
      emittedStructuredMessageIds: this.emittedStructuredMessageIds,
      partTypes: this.partTypes,
      subAgentsByCallId: this.subAgentsByCallId,
      subAgentCallIdByChildSessionId: this.subAgentCallIdByChildSessionId,
      pendingChildToolPartsBySessionId: this.pendingChildToolPartsBySessionId,
      modelContextWindowsByModelKey: this.modelContextWindowsByModelKey,
      onAssistantModelContextWindowResolved: (contextWindowMaxTokens) => {
        this.accumulatedUsage.contextWindowMaxTokens = contextWindowMaxTokens;
        if (!this.config.model) {
          this.selectedModelContextWindowMaxTokens = contextWindowMaxTokens;
        }
      },
    });

    const events: AgentStreamEvent[] = [];

    for (const translatedEvent of translated) {
      if (translatedEvent.type === "permission_requested") {
        const autoApproved = await this.tryAutoApproveToolPermission(translatedEvent.request);
        if (autoApproved) {
          continue;
        }
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
      events.push(translatedEvent);
    }

    return events;
  }

  private async tryAutoApproveToolPermission(request: AgentPermissionRequest): Promise<boolean> {
    if (this.currentMode !== OPENCODE_FULL_ACCESS_MODE_ID || request.kind !== "tool") {
      return false;
    }

    try {
      await this.client.permission.reply({
        requestID: request.id,
        directory: this.config.cwd,
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
