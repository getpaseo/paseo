import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { Logger } from "pino";
import stripAnsi from "strip-ansi";
import { z } from "zod";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type McpServerConfig,
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
  type AgentSlashCommandKind,
  type AgentStreamEvent,
  type AgentUsage,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
} from "../../agent-sdk-types.js";
import { importSessionFromPersistence } from "../../provider-session-import.js";
import { runProviderTurn } from "../provider-runner.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { composeSystemPromptParts } from "../../system-prompt.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "../diagnostic-utils.js";
import {
  getUserMessageText,
  streamPiHistory,
  type PiCapturedUserMessageEntry,
} from "./history-mapper.js";
import { materializeProviderImage } from "../provider-image-output.js";
import { PiCliRuntime } from "./cli-runtime.js";
import { revertPiConversation } from "./rewind.js";
import { listPiImportableSessions, readPiImportSessionConfig } from "./session-descriptor.js";
import type { PiRuntime, PiRuntimeSession } from "./runtime.js";
import type {
  PiAgentSessionEvent,
  PiAgentMessage,
  PiCommandsRpcType,
  PiImageContent,
  PiModel,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionStats,
  PiSessionState,
  PiThinkingLevel,
} from "./rpc-types.js";
import {
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

const PI_PROVIDER = "pi";
const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = "medium";
const PI_BINARY_COMMAND = process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";
const PI_CATALOG_REQUEST_TIMEOUT_MS = 120_000;
const PASEO_PI_TREE_EXTENSION_COMMAND = "paseo_tree";
const PASEO_PI_CAPTURE_EXTENSION_COMMAND = "paseo_capture_entries";
const PASEO_PI_ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const PASEO_PI_COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const DEFAULT_PI_EXTENSION_RESULT_TIMEOUT_MS = 30_000;
const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";
const PI_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const COMBINED_ASK_USER_METADATA = "ask_user_select_optional_comment";

export const PiProviderParamsSchema = z
  .object({
    sessionDir: z.string().min(1).optional(),
    extensionTimeoutMs: z.number().int().positive().default(DEFAULT_PI_EXTENSION_RESULT_TIMEOUT_MS),
  })
  .strict();

type PiProviderParams = z.infer<typeof PiProviderParamsSchema>;

const PI_HANDLED_BUILTIN_SLASH_COMMANDS: AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
    kind: "command",
  },
];

function mapPiCommandKind(source: PiRpcSlashCommand["source"]): AgentSlashCommandKind {
  if (source === "skill") {
    return "skill";
  }
  return "command";
}

const PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const PI_THINKING_OPTIONS: ReadonlyArray<{
  id: PiThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Maximum reasoning" },
] as const;

interface PiRpcAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  commandsRpcType?: PiCommandsRpcType;
  runtime?: PiRuntime;
}

interface PiPromptPayload {
  text: string;
  images?: PiImageContent[];
}

interface PiModelReference {
  provider?: string;
  id: string;
}

interface PiPersistenceMetadata {
  cwd?: string;
  model?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
}

interface StartTurnResult {
  turnId: string;
}

interface PiRpcAgentSessionOptions {
  runtimeSession: PiRuntimeSession;
  config: AgentSessionConfig;
  initialState: PiSessionState;
  capabilities: AgentCapabilityFlags;
  cleanup?: () => void;
  extensionTimeoutMs?: number;
}

interface PiResumeConfig {
  cwd: string;
  model?: string;
  thinkingOptionId?: string;
  config: AgentSessionConfig;
}

interface PiMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: false;
  oauth?: false;
}

interface PiMcpConfigFile {
  path: string;
  cleanup: () => void;
}

interface PiTempFile {
  path: string;
  cleanup: () => void;
}

interface PiCapturedEntry extends PiCapturedUserMessageEntry {
  parentId: string | null;
}

interface PendingPiUserMessage {
  text: string;
  turnId: string | undefined;
}

interface PendingLocalPrompt {
  turnId: string;
  text: string;
  outputs: string[];
}

interface PendingExtensionResult {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveAskUserDialog {
  allowComment: boolean;
  allowFreeform: boolean;
  allowMultiple: boolean;
}

interface PendingCombinedAskUserResponse {
  comment: string;
  freeform: string | null;
}

interface ExtensionUiMappingOptions {
  combineOptionalComment?: boolean;
  allowFreeform?: boolean;
}

interface PiSlashCommandInvocation {
  commandName: string;
  args?: string;
}

type AutoCompactMode = boolean | "toggle" | "unknown";

function normalizePiModelLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/[_\s]+/g, " ");
  const vendorSeparatorIndex = normalizedLabel.indexOf(": ");
  if (vendorSeparatorIndex === -1) {
    return normalizedLabel;
  }

  return normalizedLabel.slice(vendorSeparatorIndex + 2).trim();
}

export function transformPiModels(models: AgentModelDefinition[]): AgentModelDefinition[] {
  return models.map((model) => {
    if (!model.label.includes("/")) {
      return model;
    }

    const segments = model.label.split("/").filter((segment) => segment.length > 0);
    const rawLabel = segments.at(-1);
    if (!rawLabel) {
      return model;
    }

    return {
      ...model,
      label: normalizePiModelLabel(rawLabel),
      description: model.description ?? model.label,
    };
  });
}

function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function normalizePiThinkingOption(value: string | null | undefined): PiThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isPiThinkingLevel(value) ? value : null;
}

function parseAutoCompactMode(value: string | undefined): AutoCompactMode {
  const mode = (value ?? "toggle").trim().toLowerCase();
  if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") {
    return true;
  }
  if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") {
    return false;
  }
  if (mode === "toggle") {
    return "toggle";
  }
  return "unknown";
}

function mapThinkingOption(option: (typeof PI_THINKING_OPTIONS)[number]) {
  const mappedOption = {
    id: option.id,
    label: option.label,
    description: option.description,
  };
  if (option.isDefault) {
    return {
      ...mappedOption,
      isDefault: true,
    };
  }
  return mappedOption;
}

function toAgentUsage(stats: PiSessionStats): AgentUsage | undefined {
  const inputTokens = stats.tokens?.input ?? 0;
  const cachedInputTokens = stats.tokens?.cacheRead ?? 0;
  const outputTokens = stats.tokens?.output ?? 0;
  const totalCostUsd = stats.cost ?? 0;
  const contextWindowMaxTokens = stats.contextUsage?.contextWindow ?? undefined;
  const contextWindowUsedTokens = stats.contextUsage?.tokens ?? undefined;

  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    outputTokens === 0 &&
    totalCostUsd === 0 &&
    contextWindowMaxTokens === undefined &&
    contextWindowUsedTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalCostUsd,
    ...(typeof contextWindowMaxTokens === "number" ? { contextWindowMaxTokens } : {}),
    ...(typeof contextWindowUsedTokens === "number" ? { contextWindowUsedTokens } : {}),
  };
}

function piModelSupportsImageInput(model: PiModel | null | undefined): boolean {
  return model?.input?.includes("image") === true;
}

function renderTextOnlyImageHint(image: { data: string; mimeType: string }): string {
  try {
    const materialized = materializeProviderImage({
      data: image.data,
      mimeType: image.mimeType,
    });
    return `[Image available at: ${materialized.path}]`;
  } catch (error) {
    return `[Image attachment omitted: failed to write local file (${toDiagnosticErrorMessage(error)})]`;
  }
}

function convertPromptInput(
  prompt: AgentPromptInput,
  options: { model: PiModel | null | undefined },
): PiPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }

  const textParts: string[] = [];
  const images: PiImageContent[] = [];
  const forwardImages = piModelSupportsImageInput(options.model);

  for (const block of prompt) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "image") {
      if (forwardImages) {
        images.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
      } else {
        textParts.push(renderTextOnlyImageHint(block));
      }
      continue;
    }

    textParts.push(renderPromptAttachmentAsText(block));
  }

  const payload: PiPromptPayload = {
    text: textParts.join("\n\n"),
  };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

function parseModelReference(modelId: string | null): PiModelReference | null {
  if (!modelId) {
    return null;
  }
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    if (provider && id) {
      return { provider, id };
    }
  }
  if (modelId.includes(":")) {
    const [provider, ...rest] = modelId.split(":");
    const id = rest.join(":");
    if (provider && id) {
      return { provider, id };
    }
  }
  return { id: modelId };
}

function parsePersistenceMetadata(metadata: AgentMetadata | undefined): PiPersistenceMetadata {
  if (!metadata) {
    return {};
  }
  return {
    ...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.thinkingOptionId === "string"
      ? { thinkingOptionId: metadata.thinkingOptionId }
      : {}),
    ...(typeof metadata.systemPrompt === "string" ? { systemPrompt: metadata.systemPrompt } : {}),
  };
}

function buildResumeConfig(
  metadata: PiPersistenceMetadata,
  overrides: Partial<AgentSessionConfig> | undefined,
): PiResumeConfig {
  const overrideConfig = overrides ?? {};
  const cwd = overrideConfig.cwd ?? metadata.cwd ?? process.cwd();
  const model = overrideConfig.model ?? metadata.model;
  const thinkingOptionId = overrideConfig.thinkingOptionId ?? metadata.thinkingOptionId;
  return {
    cwd,
    model,
    thinkingOptionId,
    config: {
      ...overrideConfig,
      provider: PI_PROVIDER,
      cwd,
      model,
      thinkingOptionId,
      systemPrompt: overrideConfig.systemPrompt ?? metadata.systemPrompt,
    },
  };
}

function toPiMcpConfig(config: McpServerConfig): PiMcpServerConfig {
  if (config.type === "stdio") {
    return {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  }

  return {
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    auth: false,
    oauth: false,
  };
}

function resolvePiAgentDir(env: Record<string, string> | undefined): string {
  // Match pi-mcp-adapter's agent-directory resolution so we preserve the config it replaces.
  const configured = env?.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homedir(), ".pi", "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolvePath(homedir(), configured.slice(2));
  }
  return resolvePath(configured);
}

function createPiMcpConfigFile(
  servers: Record<string, McpServerConfig>,
  env: Record<string, string> | undefined,
): PiMcpConfigFile {
  // pi-mcp-adapter treats --mcp-config as a replacement for its Pi global layer, not an
  // additional layer. Rebuild that layer here; the adapter still loads shared and project files.
  const globalConfigPath = join(resolvePiAgentDir(env), "mcp.json");
  let globalConfig: unknown = {};
  if (existsSync(globalConfigPath)) {
    const contents = readFileSync(globalConfigPath, "utf8");
    try {
      globalConfig = JSON.parse(contents) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse Pi MCP config: ${globalConfigPath}`, { cause: error });
      }
      throw error;
    }
  }
  if (!isRecord(globalConfig)) {
    throw new Error(`Pi MCP config must contain a JSON object: ${globalConfigPath}`);
  }
  let configuredServers: Record<string, unknown> = {};
  if (isRecord(globalConfig.mcpServers)) {
    configuredServers = globalConfig.mcpServers;
  } else if (isRecord(globalConfig["mcp-servers"])) {
    configuredServers = globalConfig["mcp-servers"];
  }
  const mcpServers: Record<string, unknown> = { ...configuredServers };
  for (const [name, serverConfig] of Object.entries(servers)) {
    mcpServers[name] = toPiMcpConfig(serverConfig);
  }

  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-mcp-"));
  const filePath = join(dir, "mcp.json");
  const mergedConfig: Record<string, unknown> = { ...globalConfig, mcpServers };
  // Emit one canonical server key so a stale alias cannot shadow the injected definitions.
  delete mergedConfig["mcp-servers"];
  writeFileSync(filePath, `${JSON.stringify(mergedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function createPiPaseoExtensionFile(): PiTempFile {
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-extension-"));
  const filePath = join(dir, "paseo-integration.mjs");
  writeFileSync(
    filePath,
    `
	function decodePayload(encoded) {
	  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	}

	function readTextContent(content) {
	  if (typeof content === "string") {
	    return content;
	  }
	  if (!Array.isArray(content)) {
	    return "";
	  }
	  return content
	    .filter((part) => part && part.type === "text" && typeof part.text === "string")
	    .map((part) => part.text)
	    .join("\\n\\n");
	}

	function getCapturedUserEntries(ctx) {
	  return ctx.sessionManager
	    .getEntries()
	    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
	    .map((entry) => ({
	      id: entry.id,
	      parentId: entry.parentId ?? null,
	      text: readTextContent(entry.message.content),
	    }));
	}

	function emitEntryCapture(ctx, reason, requestId) {
	  ctx.ui.notify(
	    "${PASEO_PI_ENTRY_CAPTURE_MARKER} " +
	      JSON.stringify({ reason, requestId, entries: getCapturedUserEntries(ctx) }),
	    "info",
	  );
	}

	function emitCommandResult(ctx, requestId, result) {
	  ctx.ui.notify(
	    "${PASEO_PI_COMMAND_RESULT_MARKER} " + JSON.stringify({ requestId, ...result }),
	    result.ok ? "info" : "error",
	  );
	}
	
	export default function paseoIntegration(pi) {
	  pi.on("session_start", async (_event, ctx) => {
	    emitEntryCapture(ctx, "session_start");
	  });

	  pi.on("turn_end", async (_event, ctx) => {
	    emitEntryCapture(ctx, "turn_end");
	  });

	  pi.registerCommand("${PASEO_PI_CAPTURE_EXTENSION_COMMAND}", {
	    description: "Internal Paseo entry capture bridge",
	    handler: async (args, ctx) => {
	      const payload = decodePayload(args.trim());
	      emitEntryCapture(ctx, "command", payload.requestId);
	    },
	  });

	  pi.registerCommand("${PASEO_PI_TREE_EXTENSION_COMMAND}", {
	    description: "Internal Paseo tree navigation bridge",
	    handler: async (args, ctx) => {
	      const payload = decodePayload(args.trim());
	      try {
	        const result = await ctx.navigateTree(payload.targetId, { summarize: false });
	        emitEntryCapture(ctx, "tree_navigation");
	        emitCommandResult(ctx, payload.requestId, { ok: true, result });
	      } catch (error) {
	        const message = error instanceof Error ? error.message : String(error);
	        emitCommandResult(ctx, payload.requestId, { ok: false, error: message });
	        throw error;
	      }
	    },
	  });
	}
`.trimStart(),
    "utf8",
  );
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function combineCleanup(cleanups: Array<(() => void) | undefined>): (() => void) | undefined {
  const activeCleanups = cleanups.filter((cleanup): cleanup is () => void => Boolean(cleanup));
  if (activeCleanups.length === 0) {
    return undefined;
  }
  return () => {
    for (const cleanup of activeCleanups) {
      cleanup();
    }
  };
}

function isPiMcpAdapterCommand(command: PiRpcSlashCommand): boolean {
  if (command.source !== "extension" || !/^mcp(?::\d+)?$/.test(command.name)) {
    return false;
  }
  if (!command.sourceInfo) {
    return true;
  }
  return JSON.stringify(command.sourceInfo).includes("pi-mcp-adapter");
}

function withPiMcpCapability(supportsMcpServers: boolean): AgentCapabilityFlags {
  return {
    ...PI_CAPABILITIES,
    supportsMcpServers,
  };
}

function isPiRequestAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /\brequest was aborted\b|\babort(ed)?\b/i.test(toDiagnosticErrorMessage(error));
}

function resolveThinkingOptionId(
  cachedThinkingOptionId: string | null,
  sessionThinkingLevel: PiThinkingLevel,
): PiThinkingLevel | null {
  const currentThinking = cachedThinkingOptionId ?? sessionThinkingLevel;
  return normalizePiThinkingOption(currentThinking);
}

function modelToId(model: PiModel | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function piAssistantText(message: Extract<PiAgentMessage, { role: "assistant" }>): string | null {
  const text = message.content
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      if (part.type === "thinking") {
        return [part.thinking];
      }
      return [];
    })
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function formatPiErrorMessage(message: Extract<PiAgentMessage, { role: "assistant" }>): string {
  const headline = message.errorMessage?.trim() || "Pi turn failed";
  const details = [
    message.stopReason ? `stopReason=${message.stopReason}` : null,
    message.provider && message.model ? `model=${message.provider}/${message.model}` : null,
    message.responseModel ? `responseModel=${message.responseModel}` : null,
    message.responseId ? `responseId=${message.responseId}` : null,
  ].filter((detail): detail is string => detail !== null);
  const partialText = piAssistantText(message);
  if (partialText) {
    details.push(`partial=${JSON.stringify(partialText.slice(0, 500))}`);
  }
  return details.length > 0 ? `${headline} (${details.join(", ")})` : headline;
}

function latestPiErrorMessage(messages: PiAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  if (!latestAssistant || !latestAssistant.errorMessage?.trim()) {
    return null;
  }
  return formatPiErrorMessage(latestAssistant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseExtensionMarkerPayload(
  message: string,
  marker: string,
): Record<string, unknown> | null {
  const prefix = `${marker} `;
  if (!message.startsWith(prefix)) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseCapturedEntries(value: unknown): PiCapturedEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): PiCapturedEntry[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = optionalString(entry.id)?.trim();
    const text = optionalString(entry.text);
    if (!id || text === undefined) {
      return [];
    }
    const parentId = entry.parentId === null ? null : optionalString(entry.parentId)?.trim();
    return [
      {
        id,
        parentId: parentId || null,
        text,
      },
    ];
  });
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readActiveAskUserDialog(toolName: string, args: unknown): ActiveAskUserDialog | null {
  if (toolName !== "ask_user" || !isRecord(args)) {
    return null;
  }
  return {
    allowComment: optionalBoolean(args.allowComment) ?? false,
    allowFreeform: optionalBoolean(args.allowFreeform) ?? true,
    allowMultiple: optionalBoolean(args.allowMultiple) ?? false,
  };
}

function isOptionalInputPlaceholder(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function getInputQuestionTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInputPlaceholder(placeholder)) {
    return title ?? "Enter a value";
  }
  if (/\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)) {
    return "Optional comment";
  }
  return "Optional response";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isPiAskUserFreeformOption(option: string): boolean {
  return option === PI_ASK_USER_FREEFORM_SENTINEL;
}

function mapExtensionUiRequestToPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  options: ExtensionUiMappingOptions = {},
): AgentPermissionRequest | null {
  switch (event.method) {
    case "select": {
      const selectOptions = readStringArray(event.options);
      if (options.combineOptionalComment) {
        return buildCombinedAskUserQuestionPermission(event, {
          question: optionalString(event.title) ?? "Select an option",
          options: selectOptions,
          allowFreeform: options.allowFreeform === true,
        });
      }
      return buildExtensionUiQuestionPermission(event, {
        question: optionalString(event.title) ?? "Select an option",
        options: selectOptions,
        multiSelect: false,
      });
    }
    case "input": {
      const placeholder = optionalString(event.placeholder);
      const title = optionalString(event.title);
      const allowEmpty = isOptionalInputPlaceholder(placeholder);
      return buildExtensionUiQuestionPermission(event, {
        question: getInputQuestionTitle(title, placeholder),
        options: [],
        multiSelect: false,
        ...(placeholder ? { placeholder } : {}),
        ...(allowEmpty ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return buildExtensionUiQuestionPermission(event, {
        question: optionalString(event.title) ?? "Edit text",
        options: [],
        multiSelect: false,
      });
    case "confirm":
      return buildExtensionUiQuestionPermission(event, {
        question: [optionalString(event.title), optionalString(event.message)]
          .filter(Boolean)
          .join("\n\n"),
        options: ["Yes", "No"],
        multiSelect: false,
      });
    default:
      return null;
  }
}

function buildExtensionUiQuestionPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    question: string;
    options: string[];
    multiSelect: boolean;
    placeholder?: string;
    allowEmpty?: boolean;
    dismissLabel?: string;
  },
): AgentPermissionRequest {
  return {
    id: event.id,
    provider: PI_PROVIDER,
    name: `Pi ${event.method}`,
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: input.options.map((label) => ({ label })),
          multiSelect: input.multiSelect,
          ...(input.placeholder ? { placeholder: input.placeholder } : {}),
          ...(input.allowEmpty ? { allowEmpty: true } : {}),
          ...(input.dismissLabel ? { dismissLabel: input.dismissLabel } : {}),
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
    },
  };
}

function buildCombinedAskUserQuestionPermission(
  event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    question: string;
    options: string[];
    allowFreeform: boolean;
  },
): AgentPermissionRequest {
  const visibleOptions = input.options.filter((option) => !isPiAskUserFreeformOption(option));
  const allowOther = input.allowFreeform || visibleOptions.length !== input.options.length;
  return {
    id: event.id,
    provider: PI_PROVIDER,
    name: "Pi ask_user",
    kind: "question",
    title: input.question,
    input: {
      questions: [
        {
          question: input.question,
          header: QUESTION_RESPONSE_HEADER,
          options: visibleOptions.map((label) => ({ label })),
          multiSelect: false,
          ...(allowOther ? { allowOther: true } : {}),
        },
        {
          question: "Optional comment",
          header: QUESTION_COMMENT_HEADER,
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
        },
      ],
    },
    metadata: {
      extensionUiMethod: event.method,
      answerHeader: QUESTION_RESPONSE_HEADER,
      commentHeader: QUESTION_COMMENT_HEADER,
      combinedAskUser: COMBINED_ASK_USER_METADATA,
      selectOptions: visibleOptions,
      ...(allowOther ? { freeformSentinel: PI_ASK_USER_FREEFORM_SENTINEL } : {}),
    },
  };
}

function permissionAnswer(input: AgentMetadata | undefined, header: string): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const answer = answers[header];
  return typeof answer === "string" ? answer : null;
}

function firstPermissionAnswer(input: AgentMetadata | undefined): string | null {
  const answers = isRecord(input?.answers) ? input.answers : null;
  if (!answers) {
    return null;
  }
  const first = Object.values(answers).find((value) => typeof value === "string");
  return typeof first === "string" ? first : null;
}

function isCombinedAskUserPermission(request: AgentPermissionRequest): boolean {
  return request.metadata?.combinedAskUser === COMBINED_ASK_USER_METADATA;
}

function buildCombinedAskUserSelectionResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): {
  uiResponse: { value?: string; cancelled?: boolean };
  pendingResponse: PendingCombinedAskUserResponse | null;
} {
  if (response.behavior === "deny") {
    return { uiResponse: { cancelled: true }, pendingResponse: null };
  }

  const answer = permissionAnswer(response.updatedInput, QUESTION_RESPONSE_HEADER);
  if (answer === null) {
    return { uiResponse: { cancelled: true }, pendingResponse: null };
  }

  const selectOptions = readStringArray(request.metadata?.selectOptions);
  const freeformSentinel = optionalString(request.metadata?.freeformSentinel);
  const isFreeform = Boolean(freeformSentinel) && !selectOptions.includes(answer);
  const comment = permissionAnswer(response.updatedInput, QUESTION_COMMENT_HEADER) ?? "";
  return {
    uiResponse: { value: isFreeform ? freeformSentinel : answer },
    pendingResponse: {
      comment,
      freeform: isFreeform ? answer : null,
    },
  };
}

function buildExtensionUiResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): { value?: string; confirmed?: boolean; cancelled?: boolean } {
  if (response.behavior === "deny") {
    return { cancelled: true };
  }

  const method = optionalString(request.metadata?.extensionUiMethod);
  const answer = firstPermissionAnswer(response.updatedInput);
  if (answer === null) {
    return { cancelled: true };
  }

  if (method === "confirm") {
    return { confirmed: /^yes$/i.test(answer.trim()) };
  }
  return { value: answer };
}

function mapPiModel(model: PiModel): AgentModelDefinition {
  return {
    provider: PI_PROVIDER,
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions: model.reasoning ? PI_THINKING_OPTIONS.map(mapThinkingOption) : undefined,
    defaultThinkingOptionId: model.reasoning ? DEFAULT_PI_THINKING_LEVEL : undefined,
  };
}

function createRuntime(
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
  commandsRpcType?: PiCommandsRpcType,
): PiRuntime {
  return new PiCliRuntime({ logger, runtimeSettings, commandsRpcType });
}

export class PiRpcAgentSession implements AgentSession {
  readonly provider = PI_PROVIDER;
  readonly capabilities: AgentCapabilityFlags;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, PiTrackedToolCall>();
  private readonly pendingExtensionUiRequests = new Map<string, AgentPermissionRequest>();
  private activeAskUserDialog: ActiveAskUserDialog | null = null;
  private pendingCombinedAskUserResponse: PendingCombinedAskUserResponse | null = null;
  private activeTurnId: string | null = null;
  private pendingLocalPrompt: PendingLocalPrompt | null = null;
  private activeAssistantMessageId: string | null = null;
  private lastKnownThinkingOptionId: string | null;
  currentLeafOverrideId: string | null | undefined;
  private readonly capturedUserEntries: PiCapturedEntry[] = [];
  private readonly capturedUserEntriesById = new Map<string, PiCapturedEntry>();
  private readonly seenUserEntryIds = new Set<string>();
  private readonly pendingUserMessages: PendingPiUserMessage[] = [];
  private readonly pendingExtensionResults = new Map<string, PendingExtensionResult>();
  private outOfBandCompactionEmit: ((event: AgentStreamEvent) => void) | null = null;
  private outOfBandCompactionStarted = false;
  private outOfBandCompactionCompleted = false;
  private state: PiSessionState;
  private closed = false;

  constructor(options: PiRpcAgentSessionOptions) {
    this.runtimeSession = options.runtimeSession;
    this.config = options.config;
    this.state = options.initialState;
    this.capabilities = options.capabilities;
    this.cleanup = options.cleanup;
    this.lastKnownThinkingOptionId =
      normalizePiThinkingOption(options.config.thinkingOptionId) ??
      this.state.thinkingLevel ??
      null;
    this.extensionTimeoutMs = options.extensionTimeoutMs ?? DEFAULT_PI_EXTENSION_RESULT_TIMEOUT_MS;

    this.runtimeSession.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
  }

  private readonly runtimeSession: PiRuntimeSession;
  private readonly config: AgentSessionConfig;
  private readonly cleanup?: () => void;
  private readonly extensionTimeoutMs: number;

  get id(): string | null {
    return this.state.sessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.state.sessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<StartTurnResult> {
    if (this.activeTurnId) {
      throw new Error("A Pi turn is already active");
    }

    const payload = convertPromptInput(prompt, { model: this.state.model });
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.pendingLocalPrompt = { turnId, text: payload.text, outputs: [] };
    this.activeAssistantMessageId = null;
    const shouldProbeForNoTurnPrompt = this.parseSlashCommandInput(payload.text) !== null;

    void (async () => {
      try {
        const ack = await this.runtimeSession.prompt(payload.text, payload.images);
        if (ack.agentInvoked === false) {
          await this.completeNoTurnPrompt(turnId);
          return;
        }
        if (ack.agentInvoked === undefined && shouldProbeForNoTurnPrompt) {
          await this.completePromptIfHandledWithoutTurn(turnId);
        }
      } catch (error) {
        if (this.activeTurnId !== turnId) {
          return;
        }
        this.activeTurnId = null;
        this.pendingLocalPrompt = null;
        if (isPiRequestAbortError(error)) {
          this.emit({
            type: "turn_canceled",
            provider: PI_PROVIDER,
            turnId,
            reason: toDiagnosticErrorMessage(error),
          });
          return;
        }
        this.emit({
          type: "turn_failed",
          provider: PI_PROVIDER,
          turnId,
          error: toDiagnosticErrorMessage(error),
        });
      }
    })();

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    await this.requestEntryCapture("history");
    yield* streamPiHistory(
      PI_PROVIDER,
      await this.runtimeSession.getMessages(),
      this.capturedUserEntries,
    );
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    await this.refreshState();
    return {
      provider: PI_PROVIDER,
      sessionId: this.state.sessionId,
      model: modelToId(this.state.model),
      thinkingOptionId: resolveThinkingOptionId(
        this.lastKnownThinkingOptionId,
        this.state.thinkingLevel,
      ),
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(modeId: string): Promise<void> {
    void modeId;
    throw new Error("Pi does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingExtensionUiRequests.values()];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const request = this.pendingExtensionUiRequests.get(requestId);
    if (!request) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }
    this.pendingExtensionUiRequests.delete(requestId);

    if (isCombinedAskUserPermission(request)) {
      const combined = buildCombinedAskUserSelectionResponse(request, response);
      this.pendingCombinedAskUserResponse = combined.pendingResponse;
      this.runtimeSession.respondToExtensionUiRequest(requestId, combined.uiResponse);
    } else {
      this.runtimeSession.respondToExtensionUiRequest(
        requestId,
        buildExtensionUiResponse(request, response),
      );
    }
    this.emit({
      type: "permission_resolved",
      provider: PI_PROVIDER,
      requestId,
      resolution: response,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: PI_PROVIDER,
      sessionId: this.state.sessionId,
      nativeHandle: this.state.sessionFile,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId ? { thinkingOptionId: this.config.thinkingOptionId } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    await this.runtimeSession.abort();
    if (turnId && this.activeTurnId === turnId) {
      this.activeTurnId = null;
      this.pendingLocalPrompt = null;
      this.emit({ type: "turn_canceled", provider: PI_PROVIDER, reason: "interrupted", turnId });
    }
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Cannot rewind the Pi conversation while a Pi turn is active");
    }
    await this.refreshState().catch(() => undefined);
    await this.requestEntryCapture("rewind");
    const targetEntry = this.capturedUserEntriesById.get(input.messageId);
    if (!targetEntry) {
      throw new Error(`Pi rewind target ${input.messageId} was not found in captured tree entries`);
    }
    await revertPiConversation({
      messageId: input.messageId,
      navigator: {
        navigateTree: (treeEntryId) => this.runPiTreeExtensionCommand(treeEntryId),
      },
    });
    // Pi keeps all tree nodes, so selecting the previous leaf later reverses this rewind.
    this.currentLeafOverrideId = targetEntry.parentId;
    this.activeToolCalls.clear();
  }

  private async runPiTreeExtensionCommand(targetId: string): Promise<unknown> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ targetId, requestId })).toString("base64url");
    await this.runtimeSession.prompt(`/${PASEO_PI_TREE_EXTENSION_COMMAND} ${payload}`);
    return await resultPromise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.runtimeSession.close();
    } finally {
      this.rejectAllExtensionResults(new Error("Pi session closed"));
      this.cleanup?.();
    }
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const commands = await this.runtimeSession.getCommands();
    const mappedCommands = new Map<string, AgentSlashCommand>(
      PI_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, { ...command }]),
    );
    for (const command of commands) {
      const knownCommand = mappedCommands.get(command.name);
      mappedCommands.set(command.name, {
        name: command.name,
        description: command.description ?? command.source,
        argumentHint: knownCommand?.argumentHint ?? "",
        kind: mapPiCommandKind(command.source),
      });
    }
    return [...mappedCommands.values()];
  }

  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): { run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void> } | null {
    if (typeof prompt !== "string") {
      return null;
    }
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) {
      return null;
    }
    const commandName = parsed.commandName.toLowerCase();
    if (commandName === "compact") {
      return {
        run: async ({ emit }) => {
          await this.executeCompactCommand(parsed.args, emit);
        },
      };
    }
    if (commandName === "autocompact") {
      return {
        run: async ({ emit }) => {
          await this.executeAutoCompactCommand(parsed.args, emit);
        },
      };
    }
    return null;
  }

  async setModel(modelId: string | null): Promise<void> {
    const parsedReference = parseModelReference(modelId);
    if (!parsedReference) {
      return;
    }
    if (!parsedReference.provider) {
      throw new Error(`Pi model id must include a provider: ${modelId}`);
    }

    const model = await this.runtimeSession.setModel(parsedReference.provider, parsedReference.id);
    this.state = {
      ...this.state,
      model,
    };
    this.config.model = `${model.provider}/${model.id}`;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const thinkingLevel = normalizePiThinkingOption(thinkingOptionId) ?? DEFAULT_PI_THINKING_LEVEL;
    await this.runtimeSession.setThinkingLevel(thinkingLevel);
    this.lastKnownThinkingOptionId = thinkingLevel;
    this.config.thinkingOptionId = thinkingLevel;
    this.state = {
      ...this.state,
      thinkingLevel,
    };
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private currentTurnIdForEvent(): string | undefined {
    return this.activeTurnId ?? undefined;
  }

  private async completeNoTurnPrompt(turnId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (this.activeTurnId !== turnId || this.pendingLocalPrompt?.turnId !== turnId) {
      return;
    }
    this.emitPendingLocalPrompt();
    this.completeTurn(turnId, []);
  }

  private async completePromptIfHandledWithoutTurn(turnId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    let runtimeState: PiSessionState;
    try {
      runtimeState = await this.runtimeSession.getState();
    } catch (error) {
      if (this.activeTurnId === turnId && this.pendingLocalPrompt?.turnId === turnId) {
        throw error;
      }
      return;
    }

    if (
      this.activeTurnId !== turnId ||
      this.pendingLocalPrompt?.turnId !== turnId ||
      runtimeState.isStreaming
    ) {
      return;
    }
    this.state = runtimeState;

    this.emitPendingLocalPrompt();
    this.completeTurn(turnId, []);
  }

  private emitPendingLocalPrompt(): void {
    const prompt = this.pendingLocalPrompt;
    this.pendingLocalPrompt = null;
    if (!prompt) {
      return;
    }
    if (prompt.text) {
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId: prompt.turnId,
        item: {
          type: "user_message",
          text: prompt.text,
        },
      });
    }
    for (const output of prompt.outputs) {
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId: prompt.turnId,
        item: {
          type: "assistant_message",
          text: output,
        },
      });
    }
  }

  private bufferLocalPromptOutput(message: string): void {
    if (!this.pendingLocalPrompt) {
      return;
    }
    this.pendingLocalPrompt.outputs.push(message);
  }

  private parseSlashCommandInput(text: string): PiSlashCommandInvocation | null {
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

  private async executeCompactCommand(
    customInstructions: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    if (this.outOfBandCompactionEmit) {
      throw new Error("A Pi compact command is already running");
    }
    this.outOfBandCompactionEmit = emit;
    this.outOfBandCompactionStarted = false;
    this.outOfBandCompactionCompleted = false;
    try {
      await this.runtimeSession.compact(customInstructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.outOfBandCompactionEmit === emit &&
        this.outOfBandCompactionStarted &&
        !this.outOfBandCompactionCompleted
      ) {
        this.emitCompactionTimeline({
          turnId: undefined,
          item: {
            type: "compaction",
            status: "completed",
            trigger: "manual",
          },
        });
      }
      emit({
        type: "timeline",
        provider: PI_PROVIDER,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to compact context: ${message}`,
        },
      });
    } finally {
      if (this.outOfBandCompactionEmit === emit && !this.outOfBandCompactionStarted) {
        this.outOfBandCompactionEmit = null;
        this.outOfBandCompactionStarted = false;
        this.outOfBandCompactionCompleted = false;
      }
    }
  }

  private async executeAutoCompactCommand(
    mode: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    let enabled = parseAutoCompactMode(mode);
    if (enabled === "unknown") {
      emit({
        type: "timeline",
        provider: PI_PROVIDER,
        item: {
          type: "assistant_message",
          text: "[Error] Usage: /autocompact [on|off|toggle]",
        },
      });
      return;
    }
    if (enabled === "toggle") {
      const state = await this.runtimeSession.getState();
      if (typeof state.autoCompactionEnabled !== "boolean") {
        emit({
          type: "timeline",
          provider: PI_PROVIDER,
          item: {
            type: "assistant_message",
            text: "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
          },
        });
        return;
      }
      enabled = !state.autoCompactionEnabled;
    }

    try {
      await this.runtimeSession.setAutoCompaction(enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "timeline",
        provider: PI_PROVIDER,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to set auto-compaction: ${message}`,
        },
      });
      return;
    }
    this.state = {
      ...this.state,
      autoCompactionEnabled: enabled,
    };
    emit({
      type: "timeline",
      provider: PI_PROVIDER,
      item: {
        type: "assistant_message",
        text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
      },
    });
  }

  private async requestEntryCapture(reason: string): Promise<void> {
    const requestId = randomUUID();
    const resultPromise = this.waitForExtensionResult(requestId);
    const payload = Buffer.from(JSON.stringify({ requestId, reason })).toString("base64url");
    await this.runtimeSession.prompt(`/${PASEO_PI_CAPTURE_EXTENSION_COMMAND} ${payload}`);
    await resultPromise;
  }

  private waitForExtensionResult(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtensionResults.delete(requestId);
        reject(new Error(`Pi extension result timed out for request ${requestId}`));
      }, this.extensionTimeoutMs);
      this.pendingExtensionResults.set(requestId, { resolve, reject, timer });
    });
  }

  private resolveExtensionResult(requestId: string, result: unknown): void {
    const pending = this.pendingExtensionResults.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingExtensionResults.delete(requestId);
    pending.resolve(result);
  }

  private rejectExtensionResult(requestId: string, error: Error): void {
    const pending = this.pendingExtensionResults.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingExtensionResults.delete(requestId);
    pending.reject(error);
  }

  private rejectAllExtensionResults(error: Error): void {
    for (const requestId of this.pendingExtensionResults.keys()) {
      this.rejectExtensionResult(requestId, error);
    }
  }

  private recordCapturedUserEntries(entries: PiCapturedEntry[]): void {
    const previouslySeenEntryIds = new Set(this.seenUserEntryIds);
    this.capturedUserEntries.splice(0, this.capturedUserEntries.length, ...entries);
    this.capturedUserEntriesById.clear();
    for (const entry of entries) {
      this.capturedUserEntriesById.set(entry.id, entry);
    }
    this.flushPendingUserMessages(previouslySeenEntryIds);
    for (const entry of entries) {
      this.seenUserEntryIds.add(entry.id);
    }
  }

  private flushPendingUserMessages(previouslySeenEntryIds: Set<string>): void {
    for (let index = 0; index < this.pendingUserMessages.length; index += 1) {
      const pending = this.pendingUserMessages[index]!;
      const entry = this.capturedUserEntries.find(
        (candidate) => !previouslySeenEntryIds.has(candidate.id),
      );
      if (!entry) {
        continue;
      }
      previouslySeenEntryIds.add(entry.id);
      this.pendingUserMessages.splice(index, 1);
      index -= 1;
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId: pending.turnId,
        item: {
          type: "user_message",
          text: pending.text,
          messageId: entry.id,
        },
      });
    }
  }

  private handleEntryCaptureMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_ENTRY_CAPTURE_MARKER);
    if (!payload) {
      return false;
    }
    const entries = parseCapturedEntries(payload.entries);
    this.recordCapturedUserEntries(entries);
    if (typeof payload.requestId === "string") {
      this.resolveExtensionResult(payload.requestId, entries);
    }
    return true;
  }

  private handleCommandResultMarker(message: string): boolean {
    const payload = parseExtensionMarkerPayload(message, PASEO_PI_COMMAND_RESULT_MARKER);
    if (!payload) {
      return false;
    }
    if (typeof payload.requestId !== "string") {
      return true;
    }
    if (payload.ok === true) {
      this.resolveExtensionResult(payload.requestId, payload.result);
      return true;
    }
    const error = typeof payload.error === "string" ? payload.error : "Pi extension command failed";
    this.rejectExtensionResult(payload.requestId, new Error(error));
    return true;
  }

  private handleExtensionUiRequest(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): void {
    const message = optionalString(event.message);
    if (event.method === "notify" && message) {
      if (this.handleEntryCaptureMarker(message) || this.handleCommandResultMarker(message)) {
        return;
      }
      this.bufferLocalPromptOutput(message);
    }

    if (this.respondToCombinedAskUserFollowUp(event)) {
      return;
    }

    const shouldCombineOptionalComment =
      event.method === "select" &&
      this.activeAskUserDialog?.allowComment === true &&
      this.activeAskUserDialog.allowMultiple === false;
    const request = mapExtensionUiRequestToPermission(event, {
      combineOptionalComment: shouldCombineOptionalComment,
      allowFreeform: this.activeAskUserDialog?.allowFreeform,
    });
    if (!request) {
      return;
    }

    this.pendingExtensionUiRequests.set(request.id, request);
    this.emit({
      type: "permission_requested",
      provider: PI_PROVIDER,
      request,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  private respondToCombinedAskUserFollowUp(
    event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
  ): boolean {
    const pending = this.pendingCombinedAskUserResponse;
    if (!pending || event.method !== "input") {
      return false;
    }

    const placeholder = optionalString(event.placeholder);
    if (pending.freeform !== null && !isOptionalInputPlaceholder(placeholder)) {
      this.pendingCombinedAskUserResponse = {
        ...pending,
        freeform: null,
      };
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: pending.freeform });
      return true;
    }

    if (isOptionalInputPlaceholder(placeholder)) {
      this.pendingCombinedAskUserResponse = null;
      this.runtimeSession.respondToExtensionUiRequest(event.id, { value: pending.comment });
      return true;
    }

    return false;
  }

  private handleCommandOutput(textValue: unknown): void {
    if (!this.activeTurnId) {
      return;
    }
    const text = stripAnsi(optionalString(textValue) ?? "").trim();
    if (!text) {
      return;
    }
    if (this.pendingLocalPrompt) {
      this.bufferLocalPromptOutput(text);
      return;
    }
    this.emit({
      type: "timeline",
      provider: PI_PROVIDER,
      turnId: this.currentTurnIdForEvent(),
      item: { type: "assistant_message", text },
    });
  }

  private handleRuntimeEvent(event: PiRuntimeEvent): void {
    if (event.type === "extension_ui_request") {
      this.handleExtensionUiRequest(event);
      return;
    }
    if (event.type === "process_exit") {
      this.handleProcessExit(event.error);
      return;
    }
    if (event.type === "command_output") {
      this.handleCommandOutput(event.text);
      return;
    }
    this.handleSessionEvent(event);
  }

  private handleProcessExit(error: string): void {
    this.rejectAllExtensionResults(new Error(error));
    if (!this.activeTurnId) {
      return;
    }
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.pendingLocalPrompt = null;
    this.emit({
      type: "turn_failed",
      provider: PI_PROVIDER,
      turnId,
      error,
    });
  }

  private handleSessionEvent(event: PiAgentSessionEvent): void {
    const turnId = this.currentTurnIdForEvent();

    switch (event.type) {
      case "agent_start":
        this.pendingLocalPrompt = null;
        this.emit({
          type: "thread_started",
          provider: PI_PROVIDER,
          sessionId: this.state.sessionId,
        });
        return;
      case "turn_start":
        this.pendingLocalPrompt = null;
        this.emit({
          type: "turn_started",
          provider: PI_PROVIDER,
          turnId,
        });
        return;
      case "message_start":
        this.handleMessageStart(event);
        return;
      case "message_end":
        this.handleMessageEnd(event, turnId);
        return;
      case "message_update":
        this.handleMessageUpdate(event, turnId);
        return;
      case "tool_execution_start": {
        const toolCall = parseToolArgs(event.toolName, event.args);
        this.activeToolCalls.set(event.toolCallId, toolCall);
        this.activeAskUserDialog = readActiveAskUserDialog(event.toolName, event.args);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", null, null);
        return;
      }
      case "tool_execution_update": {
        const toolCall = this.activeToolCalls.get(event.toolCallId);
        if (!toolCall) {
          return;
        }

        const partialResult = parseToolResult(event.partialResult);
        this.emitToolCallEvent(event.toolCallId, toolCall, "running", partialResult, null);
        return;
      }
      case "tool_execution_end": {
        const toolCall =
          this.activeToolCalls.get(event.toolCallId) ?? parseToolArgs(event.toolName, null);
        this.activeToolCalls.delete(event.toolCallId);

        if (event.toolName === "ask_user") {
          this.activeAskUserDialog = null;
          this.pendingCombinedAskUserResponse = null;
        }

        const result = parseToolResult(event.result);
        const error = event.isError ? event.result : null;
        const status = event.isError ? "failed" : "completed";
        this.emitToolCallEvent(event.toolCallId, toolCall, status, result, error);
        return;
      }
      case "compaction_start":
        this.emitCompactionTimeline({
          turnId,
          item: {
            type: "compaction",
            status: "loading",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "compaction_end":
        this.emitCompactionTimeline({
          turnId,
          item: {
            type: "compaction",
            status: "completed",
            trigger: event.reason === "manual" ? "manual" : "auto",
          },
        });
        return;
      case "agent_end":
        this.completeTurn(turnId, event.messages ?? []);
        return;
      default:
        return;
    }
  }

  private emitCompactionTimeline(input: {
    turnId: string | undefined;
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"];
  }): void {
    const emitOutOfBand = this.outOfBandCompactionEmit;
    if (emitOutOfBand && input.item.type === "compaction") {
      if (input.item.status === "loading") {
        this.outOfBandCompactionStarted = true;
      }
      if (input.item.status === "completed") {
        this.outOfBandCompactionCompleted = true;
      }
    }
    const event: AgentStreamEvent = {
      type: "timeline",
      provider: PI_PROVIDER,
      ...(emitOutOfBand ? {} : { turnId: input.turnId }),
      item: input.item,
    };
    if (emitOutOfBand) {
      emitOutOfBand(event);
      if (input.item.type === "compaction" && input.item.status === "completed") {
        this.outOfBandCompactionEmit = null;
        this.outOfBandCompactionStarted = false;
        this.outOfBandCompactionCompleted = false;
      }
      return;
    }
    this.emit(event);
  }

  private handleMessageUpdate(
    event: Extract<PiAgentSessionEvent, { type: "message_update" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      // Pi-compatible runtimes may emit updates without a preceding message_start.
      this.activeAssistantMessageId ??= event.message.responseId || randomUUID();
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId,
        item: {
          type: "assistant_message",
          text: event.assistantMessageEvent.delta ?? "",
          messageId: this.activeAssistantMessageId,
        },
      });
      return;
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      this.emit({
        type: "timeline",
        provider: PI_PROVIDER,
        turnId,
        item: {
          type: "reasoning",
          text: event.assistantMessageEvent.delta ?? "",
        },
      });
    }
  }

  private handleMessageStart(event: Extract<PiAgentSessionEvent, { type: "message_start" }>): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = event.message.responseId || null;
    }
  }

  private handleMessageEnd(
    event: Extract<PiAgentSessionEvent, { type: "message_end" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = null;
      return;
    }
    if (event.message.role === "custom") {
      const text = getUserMessageText(event.message.content);
      if (text) {
        this.emit({
          type: "timeline",
          provider: PI_PROVIDER,
          turnId,
          item: { type: "assistant_message", text },
        });
      }
      this.completeTurn(turnId, []);
      return;
    }

    if (event.message.role !== "user") {
      return;
    }
    const text = getUserMessageText(event.message.content);
    if (!text) {
      return;
    }
    this.pendingUserMessages.push({ text, turnId });
    void this.requestEntryCapture("message_end").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "turn_failed",
        provider: PI_PROVIDER,
        turnId,
        error: message,
      });
    });
  }

  private emitToolCallEvent(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    status: "running" | "completed" | "failed",
    result: PiToolResult,
    error: unknown,
  ): void {
    const turnId = this.currentTurnIdForEvent();
    const detail = mapToolDetail(toolCall, result);
    const baseItem = {
      type: "tool_call" as const,
      callId: toolCallId,
      name: resolveToolCallName(toolCall, result),
      detail,
    };
    const item =
      status === "failed" ? { ...baseItem, status, error } : { ...baseItem, status, error: null };
    this.emit({
      type: "timeline",
      provider: PI_PROVIDER,
      turnId,
      item,
    });
  }

  private completeTurn(turnId: string | undefined, messages: PiAgentMessage[]): void {
    this.activeTurnId = null;
    this.pendingLocalPrompt = null;
    this.activeAssistantMessageId = null;
    const errorMessage = latestPiErrorMessage(messages);
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      this.emit({
        type: "turn_failed",
        provider: PI_PROVIDER,
        turnId,
        error: errorMessage,
      });
      return;
    }
    this.emit({
      type: "turn_completed",
      provider: PI_PROVIDER,
      turnId,
    });
    void this.refreshAfterTurn(turnId);
  }

  private async refreshState(): Promise<void> {
    this.state = await this.runtimeSession.getState();
  }

  private async refreshAfterTurn(turnId: string | undefined): Promise<void> {
    await this.refreshState().catch(() => undefined);
    const usage = await this.runtimeSession
      .getSessionStats()
      .then(toAgentUsage)
      .catch(() => undefined);
    if (usage) {
      this.emit({
        type: "usage_updated",
        provider: PI_PROVIDER,
        turnId,
        usage,
      });
    }
  }
}

export class PiRpcAgentClient implements AgentClient {
  readonly provider = PI_PROVIDER;
  readonly capabilities = PI_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly providerParams: PiProviderParams;
  private readonly runtime: PiRuntime;

  constructor(options: PiRpcAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.providerParams = PiProviderParamsSchema.parse(options.providerParams ?? {});
    this.runtime =
      options.runtime ??
      createRuntime(options.logger, options.runtimeSettings, options.commandsRpcType);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const mcpConfig = await this.prepareMcpConfig(config.cwd, config.mcpServers, {
      ...this.runtimeSettings?.env,
      ...launchContext?.env,
    });
    const paseoExtension = createPiPaseoExtensionFile();
    let runtimeSession: PiRuntimeSession;
    try {
      runtimeSession = await this.runtime.startSession({
        cwd: config.cwd,
        model: config.model,
        thinkingOptionId:
          normalizePiThinkingOption(config.thinkingOptionId) ?? DEFAULT_PI_THINKING_LEVEL,
        noSession: config.internal === true,
        systemPrompt: composeSystemPromptParts(
          config.systemPrompt,
          config.daemonAppendSystemPrompt,
        ),
        env: launchContext?.env,
        mcpConfigPath: mcpConfig?.path,
        extensionPaths: [paseoExtension.path],
      });
    } catch (error) {
      mcpConfig?.cleanup();
      paseoExtension.cleanup();
      throw error;
    }
    try {
      return new PiRpcAgentSession({
        runtimeSession,
        config,
        initialState: await runtimeSession.getState(),
        capabilities: withPiMcpCapability(mcpConfig !== null),
        cleanup: combineCleanup([mcpConfig?.cleanup, paseoExtension.cleanup]),
        extensionTimeoutMs: this.providerParams.extensionTimeoutMs,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      mcpConfig?.cleanup();
      paseoExtension.cleanup();
      throw error;
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const sessionFile = handle.nativeHandle;
    if (!sessionFile) {
      throw new Error("Pi resume requires a native session file handle");
    }

    const persistenceMetadata = parsePersistenceMetadata(handle.metadata);
    const resumeConfig = buildResumeConfig(persistenceMetadata, overrides);

    const mcpConfig = await this.prepareMcpConfig(
      resumeConfig.cwd,
      resumeConfig.config.mcpServers,
      {
        ...this.runtimeSettings?.env,
        ...launchContext?.env,
      },
    );
    const paseoExtension = createPiPaseoExtensionFile();
    let runtimeSession: PiRuntimeSession;
    try {
      runtimeSession = await this.runtime.startSession({
        cwd: resumeConfig.cwd,
        env: launchContext?.env,
        session: sessionFile,
        model: resumeConfig.model,
        thinkingOptionId: normalizePiThinkingOption(resumeConfig.thinkingOptionId) ?? undefined,
        systemPrompt: composeSystemPromptParts(
          resumeConfig.config.systemPrompt,
          resumeConfig.config.daemonAppendSystemPrompt,
        ),
        mcpConfigPath: mcpConfig?.path,
        extensionPaths: [paseoExtension.path],
      });
    } catch (error) {
      mcpConfig?.cleanup();
      paseoExtension.cleanup();
      throw error;
    }
    try {
      return new PiRpcAgentSession({
        runtimeSession,
        config: resumeConfig.config,
        initialState: await runtimeSession.getState(),
        capabilities: withPiMcpCapability(mcpConfig !== null),
        cleanup: combineCleanup([mcpConfig?.cleanup, paseoExtension.cleanup]),
        extensionTimeoutMs: this.providerParams.extensionTimeoutMs,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      mcpConfig?.cleanup();
      paseoExtension.cleanup();
      throw error;
    }
  }

  async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const runtimeSession = await this.runtime.startSession({
      cwd: options.scope === "global" ? homedir() : options.cwd,
    });
    try {
      const models = transformPiModels(
        (await runtimeSession.getAvailableModels(PI_CATALOG_REQUEST_TIMEOUT_MS)).map(mapPiModel),
      );
      return { models, modes: [] };
    } finally {
      await runtimeSession.close();
    }
  }

  async listFeatures(_config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [];
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return await listPiImportableSessions({
      ...options,
      sessionDir: this.providerParams.sessionDir,
      runtimeSettings: this.runtimeSettings,
    });
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const importConfig = await readPiImportSessionConfig(input.providerHandleId);
    return importSessionFromPersistence({
      provider: PI_PROVIDER,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
      config: importConfig,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolvePiLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolvePiLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const authConfigPath = join(homedir(), ".pi", "agent", "auth.json");

      return {
        diagnostic: formatProviderDiagnostic("Pi", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [launch.command],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          {
            label: "Auth config (~/.pi/agent/auth.json)",
            value: existsSync(authConfigPath) ? "found" : "not found",
          },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "Pi diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Pi", error),
      };
    }
  }

  private async prepareMcpConfig(
    cwd: string,
    servers: Record<string, McpServerConfig> | undefined,
    env: Record<string, string> | undefined,
  ): Promise<PiMcpConfigFile | null> {
    if (!servers || Object.keys(servers).length === 0) {
      return null;
    }
    if (!(await this.detectMcpAdapter(cwd, env))) {
      return null;
    }
    return createPiMcpConfigFile(servers, env);
  }

  private async detectMcpAdapter(cwd: string, env?: Record<string, string>): Promise<boolean> {
    const runtimeSession = await this.runtime.startSession({ cwd, env }).catch((error) => {
      this.logger.debug({ err: error, cwd }, "Pi MCP adapter probe failed to start");
      return null;
    });
    if (!runtimeSession) {
      return false;
    }
    try {
      return (await runtimeSession.getCommands()).some(isPiMcpAdapterCommand);
    } catch (error) {
      this.logger.debug({ err: error, cwd }, "Pi MCP adapter probe failed");
      return false;
    } finally {
      await runtimeSession.close().catch(() => undefined);
    }
  }

  private async resolvePiLaunch(): Promise<ResolvedProviderLaunch> {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: PI_BINARY_COMMAND,
    });
  }
}
