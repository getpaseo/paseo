import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Logger } from "pino";
import stripAnsi from "strip-ansi";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentProviderNotice,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentProvider,
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
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
  type ToolCallDetail,
} from "../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
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
  formatOmpVersionSupport,
  mergeOmpRuntimeSettings,
  resolveOmpDiagnosticPaths,
  resolveOmpLaunchMode,
  resolveOmpProviderParams,
  OMP_MODES,
  type OmpModelRoleParams,
  type OmpRuntimeProviderParams,
} from "./provider-config.js";
export { formatOmpVersionSupport, resolveOmpDiagnosticPaths } from "./provider-config.js";
import { OmpSubagentCardTracker, type OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import { getUserMessageText } from "./message-history.js";
import { materializeProviderImage } from "../provider-image-output.js";
import { OmpCliRuntime } from "./cli-runtime.js";
import { listOmpImportableSessions, readOmpImportSessionConfig } from "./session-descriptor.js";
import type { OmpRuntime, OmpRuntimeSession, OmpStartSessionInput } from "./runtime.js";
import type {
  OmpAgentSessionEvent,
  OmpAgentMessage,
  OmpImageContent,
  OmpModel,
  OmpRuntimeEvent,
  OmpSessionStats,
  OmpSessionState,
  OmpThinkingLevel,
} from "./rpc-types.js";
import {
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";
import { mapOmpAvailableCommandsUpdate, mapOmpRuntimeSlashCommands } from "./commands.js";
import { streamOmpHistory } from "./history.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";
import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";
import {
  clearOmpHostToolState,
  handleOmpHostToolRuntimeEvent,
  setOmpHostTools,
} from "./host-tools.js";
import { OmpSubagentIndex } from "./subagent-index.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { mapOmpUsage } from "./usage-mapper.js";
import {
  buildOmpRpcUiPermissionResponse,
  mapOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";

const OMP_PROVIDER = "omp";
const DEFAULT_OMP_THINKING_LEVEL: OmpThinkingLevel = "medium";
const OMP_CATALOG_REQUEST_TIMEOUT_MS = 120_000;
const QUESTION_RESPONSE_HEADER = "Response";
const QUESTION_COMMENT_HEADER = "Comment";
const OMP_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const COMBINED_ASK_USER_METADATA = "ask_user_select_optional_comment";

const OMP_CORE_CAPABILITIES: AgentCapabilityFlags = {
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

const OMP_THINKING_OPTIONS: ReadonlyArray<{
  id: OmpThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Extra-high reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning" },
] as const;

export interface OmpAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  runtime?: OmpRuntime;
  subagentCardScheduler?: OmpSubagentCardScheduler;
  providerIdleScheduler?: OmpProviderIdleScheduler;
}

export interface OmpProviderIdleScheduler {
  waitForRetry(): Promise<void>;
}

interface OmpPromptPayload {
  text: string;
  images?: OmpImageContent[];
}

interface OmpModelReference {
  provider?: string;
  id: string;
}

interface OmpPersistenceMetadata {
  cwd?: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  systemPrompt?: string;
}

interface StartTurnResult {
  turnId: string;
}

interface OmpAgentSessionOptions {
  runtimeSession: OmpRuntimeSession;
  config: AgentSessionConfig;
  initialState: OmpSessionState;
  currentModeId?: string | null;
  logger: Logger;
  subagentCardScheduler?: OmpSubagentCardScheduler;
  providerIdleScheduler?: OmpProviderIdleScheduler;
  paseoTools?: PaseoToolCatalog;
  /**
   * When false (resumed sessions), replayed session events are dropped until
   * the first prompt or agent_start so history is not re-emitted as live
   * timeline items.
   */
  live?: boolean;
}

function createOmpProviderIdleScheduler(): OmpProviderIdleScheduler {
  return {
    waitForRetry: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

interface OmpResumeConfig {
  cwd: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  config: AgentSessionConfig;
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
  provider?: AgentProvider;
  label?: string;
  combineOptionalComment?: boolean;
  allowFreeform?: boolean;
}

interface OmpSlashCommandInvocation {
  commandName: string;
  args?: string;
}

type AutoCompactMode = boolean | "toggle" | "unknown";

function normalizeOmpModelLabel(label: string): string {
  const normalizedLabel = label.trim().replace(/[_\s]+/g, " ");
  const vendorSeparatorIndex = normalizedLabel.indexOf(": ");
  if (vendorSeparatorIndex === -1) {
    return normalizedLabel;
  }

  return normalizedLabel.slice(vendorSeparatorIndex + 2).trim();
}

export function transformOmpModels(models: AgentModelDefinition[]): AgentModelDefinition[] {
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
      label: normalizeOmpModelLabel(rawLabel),
      description: model.description ?? model.label,
    };
  });
}

function isOmpThinkingLevel(value: string | null | undefined): value is OmpThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function normalizeOmpThinkingOption(value: string | null | undefined): OmpThinkingLevel | null {
  if (!value) {
    return null;
  }
  return isOmpThinkingLevel(value) ? value : null;
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

function mapThinkingOption(option: (typeof OMP_THINKING_OPTIONS)[number]) {
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

function toAgentUsage(stats: OmpSessionStats): AgentUsage | undefined {
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

function ompModelSupportsImageInput(model: OmpModel | null | undefined): boolean {
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
  options: { model: OmpModel | null | undefined },
): OmpPromptPayload {
  if (typeof prompt === "string") {
    return { text: prompt };
  }

  const textParts: string[] = [];
  const images: OmpImageContent[] = [];
  const forwardImages = ompModelSupportsImageInput(options.model);

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

  const payload: OmpPromptPayload = {
    text: textParts.join("\n\n"),
  };
  if (images.length > 0) {
    payload.images = images;
  }
  return payload;
}

function parseModelReference(modelId: string | null): OmpModelReference | null {
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

function parsePersistenceMetadata(metadata: AgentMetadata | undefined): OmpPersistenceMetadata {
  if (!metadata) {
    return {};
  }
  return {
    ...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.thinkingOptionId === "string"
      ? { thinkingOptionId: metadata.thinkingOptionId }
      : {}),
    ...(typeof metadata.modeId === "string" ? { modeId: metadata.modeId } : {}),
    ...(typeof metadata.systemPrompt === "string" ? { systemPrompt: metadata.systemPrompt } : {}),
  };
}

function buildResumeConfig(
  metadata: OmpPersistenceMetadata,
  overrides: Partial<AgentSessionConfig> | undefined,
  provider: AgentProvider,
): OmpResumeConfig {
  const overrideConfig = overrides ?? {};
  const cwd = overrideConfig.cwd ?? metadata.cwd ?? process.cwd();
  const model = overrideConfig.model ?? metadata.model;
  const thinkingOptionId = overrideConfig.thinkingOptionId ?? metadata.thinkingOptionId;
  const modeId = overrideConfig.modeId ?? metadata.modeId;
  return {
    cwd,
    model,
    thinkingOptionId,
    modeId,
    config: {
      ...overrideConfig,
      provider,
      cwd,
      model,
      thinkingOptionId,
      modeId,
      systemPrompt: overrideConfig.systemPrompt ?? metadata.systemPrompt,
    },
  };
}

function buildResumeStartInput(input: {
  resumeConfig: OmpResumeConfig;
  sessionFile: string;
  launchContext: AgentLaunchContext | undefined;
  launchMode: { modeId: string | null; extraArgs?: string[] };
}): OmpStartSessionInput {
  return {
    cwd: input.resumeConfig.cwd,
    protocolMode: "rpc-ui",
    env: input.launchContext?.env,
    session: input.sessionFile,
    model: input.resumeConfig.model,
    thinkingOptionId: normalizeOmpThinkingOption(input.resumeConfig.thinkingOptionId) ?? undefined,
    ...(input.launchMode.modeId ? { modeId: input.launchMode.modeId } : {}),
    ...(input.launchMode.extraArgs ? { extraArgs: input.launchMode.extraArgs } : {}),
    systemPrompt: composeSystemPromptParts(
      input.resumeConfig.config.systemPrompt,
      input.resumeConfig.config.daemonAppendSystemPrompt,
    ),
  };
}

function readNativeMessageId(
  message: OmpAgentMessage & { id?: unknown; entryId?: unknown },
): string | undefined {
  if (typeof message.id === "string") {
    return message.id;
  }
  return typeof message.entryId === "string" ? message.entryId : undefined;
}

function withOmpCapabilities(): AgentCapabilityFlags {
  return {
    ...OMP_CORE_CAPABILITIES,
    supportsMcpServers: false,
    supportsNativePaseoTools: true,
  };
}

function isOmpRequestAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /\brequest was aborted\b|\babort(ed)?\b/i.test(toDiagnosticErrorMessage(error));
}

function resolveThinkingOptionId(
  cachedThinkingOptionId: string | null,
  sessionThinkingLevel: OmpThinkingLevel,
): OmpThinkingLevel | null {
  const currentThinking = cachedThinkingOptionId ?? sessionThinkingLevel;
  return normalizeOmpThinkingOption(currentThinking);
}

function modelToId(model: OmpModel | null | undefined): string | null {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
}

function ompAssistantText(message: Extract<OmpAgentMessage, { role: "assistant" }>): string | null {
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

function formatOmpErrorMessage(message: Extract<OmpAgentMessage, { role: "assistant" }>): string {
  const headline = message.errorMessage?.trim() || "OMP turn failed";
  const details = [
    message.stopReason ? `stopReason=${message.stopReason}` : null,
    message.provider && message.model ? `model=${message.provider}/${message.model}` : null,
    message.responseModel ? `responseModel=${message.responseModel}` : null,
    message.responseId ? `responseId=${message.responseId}` : null,
  ].filter((detail): detail is string => detail !== null);
  const partialText = ompAssistantText(message);
  if (partialText) {
    details.push(`partial=${JSON.stringify(partialText.slice(0, 500))}`);
  }
  return details.length > 0 ? `${headline} (${details.join(", ")})` : headline;
}

function latestOmpErrorMessage(messages: OmpAgentMessage[]): string | null {
  const latestAssistant = messages.findLast((message) => message.role === "assistant");
  if (!latestAssistant || !latestAssistant.errorMessage?.trim()) {
    return null;
  }
  return formatOmpErrorMessage(latestAssistant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function isOmpAskUserFreeformOption(option: string): boolean {
  return option === OMP_ASK_USER_FREEFORM_SENTINEL;
}

function mapExtensionUiRequestToPermission(
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  options: ExtensionUiMappingOptions = {},
): AgentPermissionRequest | null {
  const provider = options.provider ?? OMP_PROVIDER;
  const label = options.label ?? "OMP";
  switch (event.method) {
    case "select": {
      const selectOptions = readStringArray(event.options);
      if (options.combineOptionalComment) {
        return buildCombinedAskUserQuestionPermission(event, {
          provider,
          label,
          question: optionalString(event.title) ?? "Select an option",
          options: selectOptions,
          allowFreeform: options.allowFreeform === true,
        });
      }
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
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
        provider,
        label,
        question: getInputQuestionTitle(title, placeholder),
        options: [],
        multiSelect: false,
        ...(placeholder ? { placeholder } : {}),
        ...(allowEmpty ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
        question: optionalString(event.title) ?? "Edit text",
        options: [],
        multiSelect: false,
      });
    case "confirm":
      return buildExtensionUiQuestionPermission(event, {
        provider,
        label,
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

function isExtensionUiRequestEvent(
  event: OmpRuntimeEvent,
): event is Extract<OmpRuntimeEvent, { type: "extension_ui_request" }> {
  return event.type === "extension_ui_request" && typeof event.id === "string";
}

function isProcessExitEvent(
  event: OmpRuntimeEvent,
): event is Extract<OmpRuntimeEvent, { type: "process_exit" }> {
  return event.type === "process_exit" && typeof event.error === "string";
}

function isOmpAgentSessionEvent(event: OmpRuntimeEvent): event is OmpAgentSessionEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_end":
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "compaction_start":
    case "compaction_end":
    case "agent_end":
      return true;
    default:
      return false;
  }
}

function buildExtensionUiQuestionPermission(
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    provider: AgentProvider;
    label: string;
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
    provider: input.provider,
    name: `${input.label} ${event.method}`,
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
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  input: {
    provider: AgentProvider;
    label: string;
    question: string;
    options: string[];
    allowFreeform: boolean;
  },
): AgentPermissionRequest {
  const visibleOptions = input.options.filter((option) => !isOmpAskUserFreeformOption(option));
  const allowOther = input.allowFreeform || visibleOptions.length !== input.options.length;
  return {
    id: event.id,
    provider: input.provider,
    name: `${input.label} ask_user`,
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
      ...(allowOther ? { freeformSentinel: OMP_ASK_USER_FREEFORM_SENTINEL } : {}),
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

function mapOmpModel(model: OmpModel, provider: AgentProvider): AgentModelDefinition {
  return {
    provider,
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions: model.reasoning ? OMP_THINKING_OPTIONS.map(mapThinkingOption) : undefined,
    defaultThinkingOptionId: model.reasoning ? DEFAULT_OMP_THINKING_LEVEL : undefined,
  };
}

function createRuntime(
  logger: Logger,
  runtimeSettings: ProviderRuntimeSettings | undefined,
): OmpRuntime {
  return new OmpCliRuntime({
    logger,
    runtimeSettings,
    command: ["omp"],
    commandsRpcName: "get_available_commands",
  });
}

export class OmpAgentSession implements AgentSession {
  readonly provider: AgentProvider = OMP_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = withOmpCapabilities();

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly activeToolCalls = new Map<string, OmpTrackedToolCall>();
  private readonly pendingExtensionUiRequests = new Map<string, AgentPermissionRequest>();
  private activeAskUserDialog: ActiveAskUserDialog | null = null;
  private pendingCombinedAskUserResponse: PendingCombinedAskUserResponse | null = null;
  private activeTurnId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private activeTurnStarted = false;
  private activeTurnHasUserMessage = false;
  private activeNoTurnPromptText: string | null = null;
  private readonly pendingNoTurnOutputs: Array<{ turnId: string; message: string }> = [];
  private activePromptRequestId: string | null = null;
  private readonly pendingPromptResults = new Map<string, boolean>();
  private lastKnownThinkingOptionId: string | null;
  private outOfBandCompactionEmit: ((event: AgentStreamEvent) => void) | null = null;
  private outOfBandCompactionStarted = false;
  private outOfBandCompactionCompleted = false;
  private commandCache: AgentSlashCommand[] | null = null;
  private readonly subagentIndex = new OmpSubagentIndex();
  private readonly subagentCardTracker: OmpSubagentCardTracker;
  private lastTodoItem: Extract<AgentTimelineItem, { type: "todo" }> | null = null;
  private state: OmpSessionState;
  private readonly currentModeId: string | null;
  private readonly providerIdleScheduler: OmpProviderIdleScheduler;
  private closed = false;
  private live: boolean;
  private readonly emittedUserMessageIds = new Set<string>();

  constructor(options: OmpAgentSessionOptions) {
    this.runtimeSession = options.runtimeSession;
    this.config = options.config;
    this.state = options.initialState;
    this.currentModeId = options.currentModeId ?? null;
    this.logger = options.logger;
    this.paseoTools = options.paseoTools;
    this.live = options.live ?? true;
    this.providerIdleScheduler = options.providerIdleScheduler ?? createOmpProviderIdleScheduler();
    this.subagentCardTracker = new OmpSubagentCardTracker({
      scheduler: options.subagentCardScheduler,
    });
    this.lastKnownThinkingOptionId =
      normalizeOmpThinkingOption(options.config.thinkingOptionId) ??
      this.state.thinkingLevel ??
      null;
    this.runtimeSession.onEvent((event) => {
      this.handleRuntimeEvent(event);
    });
    void this.runtimeSession.setSubagentSubscription("events").catch((eventsError: unknown) => {
      this.logger.debug(
        { err: eventsError },
        "OMP subagent event subscription unavailable; falling back to progress",
      );
      void this.runtimeSession
        .setSubagentSubscription("progress")
        .catch((progressError: unknown) => {
          this.logger.debug(
            { err: progressError },
            "OMP subagent progress subscription unavailable",
          );
        });
    });
  }

  private readonly runtimeSession: OmpRuntimeSession;
  private readonly config: AgentSessionConfig;
  private readonly logger: Logger;
  private readonly paseoTools?: PaseoToolCatalog;

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
      throw new Error("An OMP turn is already active");
    }

    const payload = convertPromptInput(prompt, { model: this.state.model });
    const turnId = randomUUID();
    this.live = true;
    this.activeTurnId = turnId;
    this.activeAssistantMessageId = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.activePromptRequestId = null;
    this.clearNoTurnBuffers();
    this.activeNoTurnPromptText = payload.text;

    void (async () => {
      try {
        const ack = await this.runtimeSession.prompt(payload.text, payload.images);
        this.activePromptRequestId = ack.requestId ?? null;
        const correlatedResult = ack.requestId
          ? this.pendingPromptResults.get(ack.requestId)
          : undefined;
        if (ack.requestId) {
          this.pendingPromptResults.delete(ack.requestId);
        }
        const agentInvoked = correlatedResult ?? ack.agentInvoked;
        if (agentInvoked === false) {
          await this.completeNoTurnPrompt(turnId);
          return;
        }
      } catch (error) {
        if (this.activeTurnId !== turnId) {
          return;
        }
        this.activeTurnId = null;
        this.activeTurnStarted = false;
        this.activeTurnHasUserMessage = false;
        this.activeAssistantMessageId = null;
        this.clearNoTurnBuffers();
        if (isOmpRequestAbortError(error)) {
          this.emit({
            type: "turn_canceled",
            provider: this.provider,
            turnId,
            reason: toDiagnosticErrorMessage(error),
          });
          return;
        }
        this.emit({
          type: "turn_failed",
          provider: this.provider,
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
    yield* streamOmpHistory({
      sessionFile: this.state.sessionFile,
      runtimeSession: this.runtimeSession,
      provider: this.provider,
    });
    for (const item of mapOmpTodoState(this.state)) {
      yield {
        type: "timeline",
        provider: this.provider,
        item,
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    await this.refreshState();
    return {
      provider: this.provider,
      sessionId: this.state.sessionId,
      model: modelToId(this.state.model),
      thinkingOptionId: resolveThinkingOptionId(
        this.lastKnownThinkingOptionId,
        this.state.thinkingLevel,
      ),
      modeId: this.currentModeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...OMP_MODES];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentModeId;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    if (!OMP_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`Invalid OMP mode '${modeId}'`);
    }
    return {
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    };
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
        buildOmpRpcUiPermissionResponse(request, response) ??
          buildExtensionUiResponse(request, response),
      );
    }
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.state.sessionId,
      nativeHandle: this.state.sessionFile,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId ? { thinkingOptionId: this.config.thinkingOptionId } : {}),
        ...(this.currentModeId ? { modeId: this.currentModeId } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    try {
      await this.runtimeSession.abort();
    } finally {
      this.terminalizeActiveWork();
    }
    if (turnId && this.activeTurnId === turnId) {
      this.activeTurnId = null;
      this.activeTurnStarted = false;
      this.activeTurnHasUserMessage = false;
      this.activeAssistantMessageId = null;
      this.clearNoTurnBuffers();
      this.emit({
        type: "turn_canceled",
        provider: this.provider,
        reason: "interrupted",
        turnId,
      });
    }
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    if (this.activeTurnId) {
      throw new Error("Cannot rewind the OMP conversation while a turn is active");
    }
    const target = input.messageId.trim();
    if (!target) {
      throw new Error("OMP rewind requires a user message id");
    }
    await this.runtimeSession.branch(target);
    await this.refreshState();
    this.activeToolCalls.clear();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.runtimeSession.close();
    } finally {
      this.clearOmpSessionState();
    }
  }

  private clearOmpSessionState(): void {
    this.subagentIndex.clear(this.runtimeSession);
    this.clearOmpTurnState();
  }

  private clearOmpTurnState(): void {
    clearOmpHostToolState(this.runtimeSession);
    this.subagentCardTracker.clear();
  }

  private terminalizeActiveWork(): void {
    for (const [toolCallId, toolCall] of this.activeToolCalls) {
      this.emitToolCallEvent(toolCallId, toolCall, "canceled", null, null);
    }
    this.activeToolCalls.clear();
    for (const event of this.subagentIndex.terminalizeRunning(this.runtimeSession)) {
      this.emit(event);
    }
    this.clearOmpTurnState();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    if (this.commandCache) {
      return this.commandCache;
    }
    const commands = await this.runtimeSession.getCommands();
    return mapOmpRuntimeSlashCommands(commands);
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
    this.live = true;
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
    if (commandName === "steer" || commandName === "follow-up") {
      const message = parsed.args?.trim();
      if (!message) {
        return null;
      }
      return {
        run: async () => {
          if (commandName === "steer") {
            this.runtimeSession.steer(message);
          } else {
            this.runtimeSession.followUp(message);
          }
        },
      };
    }
    if (commandName === "handoff") {
      return {
        run: async ({ emit }) => {
          await this.executeHandoffCommand(parsed.args, emit);
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
      throw new Error(`OMP model id must include a provider: ${modelId}`);
    }

    const model = await this.runtimeSession.setModel(parsedReference.provider, parsedReference.id);
    this.state = {
      ...this.state,
      model,
    };
    this.config.model = `${model.provider}/${model.id}`;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const thinkingLevel =
      normalizeOmpThinkingOption(thinkingOptionId) ?? DEFAULT_OMP_THINKING_LEVEL;
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
    if (this.activeTurnId !== turnId || this.activeTurnStarted || this.activeTurnHasUserMessage) {
      return;
    }
    this.emitBufferedNoTurnOutputs(turnId);
    this.completeTurn(turnId, []);
  }

  private clearNoTurnBuffers(): void {
    this.activeNoTurnPromptText = null;
    this.activePromptRequestId = null;
    this.pendingNoTurnOutputs.splice(0, this.pendingNoTurnOutputs.length);
  }

  private emitBufferedNoTurnOutputs(turnId: string): void {
    const promptText = this.activeNoTurnPromptText;
    const outputs = this.pendingNoTurnOutputs.filter((output) => output.turnId === turnId);
    this.clearNoTurnBuffers();
    if (promptText) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "user_message",
          text: promptText,
        },
      });
    }
    for (const output of outputs) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "assistant_message",
          text: output.message,
        },
      });
    }
  }

  private bufferNoTurnOutput(message: string): void {
    if (!this.activeTurnId || this.activeTurnStarted) {
      return;
    }
    this.pendingNoTurnOutputs.push({ turnId: this.activeTurnId, message });
  }

  private parseSlashCommandInput(text: string): OmpSlashCommandInvocation | null {
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
      throw new Error("An OMP compact command is already running");
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
        provider: this.provider,
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
        provider: this.provider,
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
          provider: this.provider,
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
        provider: this.provider,
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
      provider: this.provider,
      item: {
        type: "assistant_message",
        text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
      },
    });
  }

  private async executeHandoffCommand(
    instructions: string | undefined,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    try {
      await this.runtimeSession.handoff(instructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "timeline",
        provider: this.provider,
        item: {
          type: "assistant_message",
          text: `[Error] Failed to hand off turn: ${message}`,
        },
      });
    }
  }

  private handleExtensionUiRequest(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  ): void {
    const message = optionalString(event.message);
    if (event.method === "notify" && message) {
      this.bufferNoTurnOutput(message);
    }

    const sideEffectItem = this.mapExtensionUiSideEffect(event);
    if (sideEffectItem) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId: this.currentTurnIdForEvent(),
        item: sideEffectItem,
      });
      return;
    }

    if (this.respondToCombinedAskUserFollowUp(event)) {
      return;
    }

    const shouldCombineOptionalComment =
      event.method === "select" &&
      this.activeAskUserDialog?.allowComment === true &&
      this.activeAskUserDialog.allowMultiple === false;
    const request =
      mapOmpRpcUiPermissionRequest(event, { provider: this.provider }) ??
      mapExtensionUiRequestToPermission(event, {
        provider: this.provider,
        label: "OMP",
        combineOptionalComment: shouldCombineOptionalComment,
        allowFreeform: this.activeAskUserDialog?.allowFreeform,
      });
    if (!request) {
      return;
    }

    this.pendingExtensionUiRequests.set(request.id, request);
    this.emit({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: this.currentTurnIdForEvent(),
    });
  }

  private mapExtensionUiSideEffect(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
  ): AgentTimelineItem | null {
    if (event.method !== "open_url" || typeof event.url !== "string") {
      return null;
    }
    const lines = [`[Open URL](${event.url})`, `URL: ${event.url}`];
    if (typeof event.launchUrl === "string") {
      lines.push(`Launch URL: ${event.launchUrl}`);
    }
    if (typeof event.instructions === "string") {
      lines.push("", event.instructions);
    }
    return { type: "assistant_message", text: lines.join("\n") };
  }

  private respondToCombinedAskUserFollowUp(
    event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
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
    if (!this.activeTurnStarted) {
      this.bufferNoTurnOutput(text);
      return;
    }
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId: this.currentTurnIdForEvent(),
      item: { type: "assistant_message", text },
    });
  }

  private handleExtraRuntimeEvent(event: OmpRuntimeEvent): boolean {
    if (
      handleOmpHostToolRuntimeEvent(event, {
        runtimeSession: this.runtimeSession,
        paseoTools: this.paseoTools,
        logger: this.logger,
      })
    ) {
      return true;
    }
    if (event.type === "subagent_lifecycle") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_lifecycle" }>).payload;
      if (payload.parentToolCallId && this.activeToolCalls.has(payload.parentToolCallId)) {
        this.subagentCardTracker.handleLifecycle(payload, (toolCallId) =>
          this.emitActiveToolCall(toolCallId),
        );
      }
      for (const mapped of this.subagentIndex.handleLifecycle(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "subagent_progress") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_progress" }>).payload;
      if (payload.parentToolCallId && this.activeToolCalls.has(payload.parentToolCallId)) {
        this.subagentCardTracker.handleProgress(payload, (toolCallId) =>
          this.emitActiveToolCall(toolCallId),
        );
      }
      for (const mapped of this.subagentIndex.handleProgress(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "subagent_event") {
      const payload = (event as Extract<OmpRuntimeEvent, { type: "subagent_event" }>).payload;
      for (const mapped of this.subagentIndex.handleEvent(this.runtimeSession, payload)) {
        this.emit(mapped);
      }
      return true;
    }
    if (event.type === "todo_reminder") {
      const item = mapOmpTodoReminderEvent(event);
      if (item) {
        this.emitTodoItem(item);
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP todo reminder event");
      }
      return true;
    }
    if (event.type === "available_commands_update") {
      const commands = mapOmpAvailableCommandsUpdate(event);
      if (commands) {
        this.commandCache = commands;
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP command update event");
      }
      return true;
    }
    const mappedEvent = mapOmpRuntimeEventToTimelineItem(event);
    if (!mappedEvent.handled) {
      return false;
    }
    if (mappedEvent.item) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        item: mappedEvent.item,
      });
    } else {
      this.logger.debug(
        { event, reason: mappedEvent.logReason },
        "Dropped unsupported OMP runtime event",
      );
    }
    return true;
  }

  private emitActiveToolCall(toolCallId: string): boolean {
    const toolCall = this.activeToolCalls.get(toolCallId);
    return toolCall ? this.emitToolCallEvent(toolCallId, toolCall, "running", null, null) : false;
  }

  private emitTodoItem(item: AgentTimelineItem, turnId?: string): void {
    if (item.type === "todo") {
      const previous = this.lastTodoItem;
      const isDuplicate =
        previous?.items.length === item.items.length &&
        previous.items.every((previousItem, index) => {
          const nextItem = item.items[index];
          return (
            nextItem?.text === previousItem.text && nextItem.completed === previousItem.completed
          );
        });
      if (isDuplicate) {
        return;
      }
      this.lastTodoItem = item;
    }
    this.emit({ type: "timeline", provider: this.provider, turnId, item });
  }

  private handleRuntimeEvent(event: OmpRuntimeEvent): void {
    if (isExtensionUiRequestEvent(event)) {
      this.handleExtensionUiRequest(event);
      return;
    }
    if (isProcessExitEvent(event)) {
      this.handleProcessExit(event.error);
      return;
    }
    if (event.type === "command_output") {
      this.handleCommandOutput(event.text);
      return;
    }
    if (event.type === "prompt_result") {
      const requestId = optionalString("id" in event ? event.id : undefined);
      const agentInvoked =
        "agentInvoked" in event && typeof event.agentInvoked === "boolean"
          ? event.agentInvoked
          : undefined;
      if (requestId && agentInvoked !== undefined) {
        if (
          requestId === this.activePromptRequestId &&
          agentInvoked === false &&
          this.activeTurnId
        ) {
          void this.completeNoTurnPrompt(this.activeTurnId);
        } else if (this.activePromptRequestId === null) {
          this.pendingPromptResults.set(requestId, agentInvoked);
        }
      }
      return;
    }
    if (this.handleExtraRuntimeEvent(event)) {
      return;
    }
    if (isOmpAgentSessionEvent(event)) {
      if (event.type === "agent_start") {
        this.live = true;
      } else if (!this.live) {
        // A resumed OMP process replays session events for pre-existing
        // conversation on startup; that content is delivered via
        // streamHistory, so replay must not re-enter the live timeline.
        return;
      }
      this.handleSessionEvent(event);
      return;
    }
    this.logger.debug({ event }, "Dropped unknown OMP runtime event");
  }

  private handleProcessExit(error: string): void {
    this.terminalizeActiveWork();
    this.subagentIndex.clear(this.runtimeSession);
    if (!this.activeTurnId) {
      return;
    }
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.clearNoTurnBuffers();
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      turnId,
      error,
    });
  }

  private handleSessionEvent(event: OmpAgentSessionEvent): void {
    const turnId = this.currentTurnIdForEvent();

    switch (event.type) {
      case "agent_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        this.emit({
          type: "thread_started",
          provider: this.provider,
          sessionId: this.state.sessionId,
        });
        return;
      case "turn_start":
        this.activeTurnStarted = true;
        this.clearNoTurnBuffers();
        this.emit({
          type: "turn_started",
          provider: this.provider,
          turnId,
        });
        return;
      case "message_start":
        this.handleMessageStart(event);
        return;
      case "message_end":
        if (event.message.role === "user") {
          this.activeTurnHasUserMessage = true;
        }
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
        this.handleToolExecutionEnd(event, turnId);
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
        // OMP can end an internal extension-notice cycle before it starts the
        // model turn for the same prompt. That cycle has no assistant message
        // and is not the foreground turn's terminal event.
        if (!(event.messages ?? []).some((message) => message.role === "assistant")) {
          return;
        }
        // A state request is processed after OMP's RPC loop becomes promptable,
        // so do not advertise Paseo idle until it reports that transition.
        void this.completeTurnAfterProviderIdle(turnId, event.messages ?? []);
        return;
      default:
        return;
    }
  }

  private handleToolExecutionEnd(
    event: Extract<OmpAgentSessionEvent, { type: "tool_execution_end" }>,
    turnId: string | undefined,
  ): void {
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
    if (event.toolName === "task") {
      this.subagentCardTracker.delete(event.toolCallId);
    }
    if (event.toolName === "todo") {
      const item = mapOmpTodoToolResult(result);
      if (item) {
        this.emitTodoItem(item, turnId);
      } else {
        this.logger.debug({ event }, "Dropped malformed OMP todo tool result");
      }
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
      provider: this.provider,
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
    event: Extract<OmpAgentSessionEvent, { type: "message_update" }>,
    turnId: string | undefined,
  ): void {
    if (event.message.role !== "assistant") {
      return;
    }
    if (event.assistantMessageEvent.type === "text_delta") {
      // Omp-compatible runtimes may emit updates without a preceding message_start.
      this.activeAssistantMessageId ??= event.message.responseId || randomUUID();
      this.emit({
        type: "timeline",
        provider: this.provider,
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
        provider: this.provider,
        turnId,
        item: {
          type: "reasoning",
          text: event.assistantMessageEvent.delta ?? "",
        },
      });
    }
  }

  private handleMessageStart(
    event: Extract<OmpAgentSessionEvent, { type: "message_start" }>,
  ): void {
    if (event.message.role === "assistant") {
      this.activeAssistantMessageId = event.message.responseId || null;
    }
  }

  private handleMessageEnd(
    event: Extract<OmpAgentSessionEvent, { type: "message_end" }>,
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
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text },
        });
      }
      if (!this.activeTurnHasUserMessage) {
        this.completeTurn(turnId, []);
      }
      return;
    }

    if (event.message.role !== "user") {
      return;
    }
    const text = getUserMessageText(event.message.content);
    if (!text) {
      return;
    }
    const nativeMessage = event.message as OmpAgentMessage & { id?: unknown; entryId?: unknown };
    const messageId = readNativeMessageId(nativeMessage);
    const emitUserMessage = (resolvedMessageId?: string): void => {
      if (resolvedMessageId) {
        // OMP re-emits user message_end frames for entries it has already
        // surfaced (e.g. after steer or a resumed process); emit each native
        // entry exactly once.
        if (this.emittedUserMessageIds.has(resolvedMessageId)) {
          return;
        }
        this.emittedUserMessageIds.add(resolvedMessageId);
      }
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "user_message",
          text,
          ...(resolvedMessageId ? { messageId: resolvedMessageId } : {}),
        },
      });
    };
    if (messageId) {
      emitUserMessage(messageId);
      return;
    }
    void this.runtimeSession
      .getBranchMessages()
      .then((messages) =>
        emitUserMessage(messages.toReversed().find((message) => message.text === text)?.entryId),
      )
      .catch((error: unknown) => {
        this.logger.debug(
          { err: error, sessionFile: this.state.sessionFile },
          "OMP native user message ID lookup failed",
        );
        emitUserMessage();
      });
  }

  private emitToolCallEvent(
    toolCallId: string,
    toolCall: OmpTrackedToolCall,
    status: "running" | "completed" | "failed" | "canceled",
    result: OmpToolResult,
    error: unknown,
  ): boolean {
    const turnId = this.currentTurnIdForEvent();
    const detail = this.mapToolDetail(toolCallId, toolCall, result);
    if (!detail) {
      return false;
    }
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
      provider: this.provider,
      turnId,
      item,
    });
    return true;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: OmpTrackedToolCall,
    result: OmpToolResult,
  ): ToolCallDetail | null {
    return mapOmpToolDetail(toolCall, result, {
      toolCallId,
      mapSubagentDetail: (detail) =>
        this.subagentCardTracker.detailFor(toolCallId, detail) ?? detail,
    });
  }

  private completeTurn(turnId: string | undefined, messages: OmpAgentMessage[]): void {
    this.activeTurnId = null;
    this.activeAssistantMessageId = null;
    this.activeTurnStarted = false;
    this.activeTurnHasUserMessage = false;
    this.clearNoTurnBuffers();
    const errorMessage = latestOmpErrorMessage(messages);
    if (typeof errorMessage === "string" && errorMessage.length > 0) {
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: errorMessage,
      });
      return;
    }
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      turnId,
    });
    void this.refreshAfterTurn(turnId);
  }

  private async completeTurnAfterProviderIdle(
    turnId: string | undefined,
    messages: OmpAgentMessage[],
  ): Promise<void> {
    while (!this.closed && this.activeTurnId === turnId) {
      try {
        const state = await this.runtimeSession.getState();
        this.state = state;
        if (!state.isStreaming && !state.isCompacting) {
          this.completeTurn(turnId, messages);
          return;
        }
      } catch (error) {
        this.logger.debug({ err: error }, "OMP state unavailable while waiting for provider idle");
      }
      await this.providerIdleScheduler.waitForRetry();
    }
  }

  private async refreshState(): Promise<void> {
    this.state = await this.runtimeSession.getState();
  }

  private async refreshAfterTurn(turnId: string | undefined): Promise<void> {
    await this.refreshState().catch(() => undefined);
    const usage = await this.runtimeSession
      .getSessionStats()
      .then((stats) => {
        const baseUsage = toAgentUsage(stats);
        return mapOmpUsage({ stats, state: this.state, baseUsage });
      })
      .catch(() => undefined);
    if (usage) {
      this.emit({
        type: "usage_updated",
        provider: this.provider,
        turnId,
        usage,
      });
    }
  }
}

export class OmpAgentClient implements AgentClient {
  readonly provider: AgentProvider = OMP_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = withOmpCapabilities();

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly providerParams: OmpRuntimeProviderParams;
  private readonly modelRoleParams: OmpModelRoleParams;
  private readonly subagentCardScheduler?: OmpSubagentCardScheduler;
  private readonly providerIdleScheduler?: OmpProviderIdleScheduler;
  private readonly runtime: OmpRuntime;

  constructor(options: OmpAgentClientOptions) {
    const { runtimeProviderParams, modelRoleParams } = resolveOmpProviderParams(
      options.providerParams,
    );
    const runtimeSettings = mergeOmpRuntimeSettings(
      {
        command: {
          mode: "replace",
          argv: ["omp"],
        },
      },
      options.runtimeSettings,
    );
    this.logger = options.logger;
    this.runtimeSettings = runtimeSettings;
    this.providerParams = runtimeProviderParams;
    this.modelRoleParams = modelRoleParams;
    this.subagentCardScheduler = options.subagentCardScheduler;
    this.providerIdleScheduler = options.providerIdleScheduler;
    this.runtime = options.runtime ?? createRuntime(options.logger, runtimeSettings);
  }

  private async configureNativePaseoTools(
    runtimeSession: OmpRuntimeSession,
    catalog: PaseoToolCatalog | undefined,
  ): Promise<void> {
    if (!catalog) {
      return;
    }
    await setOmpHostTools(runtimeSession, catalog);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const launchMode = this.resolveLaunchMode(config.modeId);
    const runtimeSession = await this.runtime.startSession({
      cwd: config.cwd,
      protocolMode: "rpc-ui",
      model: config.model,
      thinkingOptionId:
        normalizeOmpThinkingOption(config.thinkingOptionId) ?? DEFAULT_OMP_THINKING_LEVEL,
      noSession: config.internal === true,
      modeId: launchMode.modeId,
      extraArgs: launchMode.extraArgs,
      systemPrompt: composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt),
      env: launchContext?.env,
    });
    try {
      await this.configureNativePaseoTools(runtimeSession, launchContext?.paseoTools);
      return new OmpAgentSession({
        runtimeSession,
        config,
        initialState: await runtimeSession.getState(),
        currentModeId: launchMode.modeId,
        logger: this.logger,
        subagentCardScheduler: this.subagentCardScheduler,
        providerIdleScheduler: this.providerIdleScheduler,
        paseoTools: launchContext?.paseoTools,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
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
      throw new Error("OMP resume requires a native session file handle");
    }

    const persistenceMetadata = parsePersistenceMetadata(handle.metadata);
    const resumeConfig = buildResumeConfig(persistenceMetadata, overrides, this.provider);

    const launchMode = this.resolveLaunchMode(resumeConfig.modeId);
    const runtimeSession = await this.runtime.startSession(
      buildResumeStartInput({
        resumeConfig,
        sessionFile,
        launchContext,
        launchMode,
      }),
    );
    try {
      await this.configureNativePaseoTools(runtimeSession, launchContext?.paseoTools);
      return new OmpAgentSession({
        runtimeSession,
        config: resumeConfig.config,
        initialState: await runtimeSession.getState(),
        currentModeId: launchMode.modeId,
        logger: this.logger,
        subagentCardScheduler: this.subagentCardScheduler,
        providerIdleScheduler: this.providerIdleScheduler,
        paseoTools: launchContext?.paseoTools,
        live: false,
      });
    } catch (error) {
      await runtimeSession.close().catch(() => undefined);
      throw error;
    }
  }

  async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const launchMode = this.resolveLaunchMode(undefined);
    const runtimeSession = await this.runtime.startSession({
      cwd: options.scope === "global" ? homedir() : options.cwd,
      protocolMode: "rpc-ui",
      modeId: launchMode.modeId,
      extraArgs: launchMode.extraArgs,
    });
    try {
      const models = transformOmpModels(
        (await runtimeSession.getAvailableModels(OMP_CATALOG_REQUEST_TIMEOUT_MS)).map((model) =>
          mapOmpModel(model, this.provider),
        ),
      );
      return { models, modes: [...OMP_MODES] };
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
    return await listOmpImportableSessions({
      ...options,
      sessionDir: this.providerParams.sessionDir,
      runtimeSettings: this.runtimeSettings,
    });
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const importConfig = await readOmpImportSessionConfig(input.providerHandleId);
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
      config: importConfig,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveOmpLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolveOmpLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const binaryRows = await buildBinaryDiagnosticRows(launch, availability, {
        versionCommand: {
          command: availability.resolvedPath ?? launch.command,
          args: [...launch.args, "--version"],
          env: this.runtimeSettings?.env,
        },
      });
      const version = binaryRows.find((row) => row.label === "Version")?.value ?? "unknown";
      const env = { ...process.env, ...this.runtimeSettings?.env };
      const paths = resolveOmpDiagnosticPaths(env);
      const bunVersion =
        (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unavailable";

      return {
        diagnostic: formatProviderDiagnostic("Oh My Pi (OMP)", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["omp", launch.command],
            pathValue: env.PATH ?? env.Path,
          })),
          ...binaryRows,
          { label: "Version support", value: formatOmpVersionSupport(version) },
          { label: "Active profile", value: paths.profile },
          { label: "Config root", value: paths.configRoot },
          { label: "Agent directory", value: paths.agentDir },
          {
            label: "Agent database",
            value: `${paths.agentDb} (${existsSync(paths.agentDb) ? "found" : "not found"})`,
          },
          { label: "XDG data root", value: paths.xdgDataRoot },
          { label: "XDG state root", value: paths.xdgStateRoot },
          { label: "XDG cache root", value: paths.xdgCacheRoot },
          {
            label: "Bun runtime",
            value: `${bunVersion}; npm-installed OMP requires Bun >= 1.3.14`,
          },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "OMP diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Oh My Pi (OMP)", error),
      };
    }
  }

  private resolveLaunchMode(modeId: string | undefined): {
    modeId: string;
    extraArgs: string[];
  } {
    return resolveOmpLaunchMode(modeId, this.modelRoleParams);
  }

  private async resolveOmpLaunch(): Promise<ResolvedProviderLaunch> {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: "omp",
    });
  }
}
