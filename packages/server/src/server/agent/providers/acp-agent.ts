import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import type { ProcessTerminator } from "../../../utils/tree-kill.js";
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AgentCapabilities as ACPAgentCapabilities,
  type Error as ACPError,
  type AnyMessage,
  type Client as ACPClient,
  type ClientCapabilities as ACPClientCapabilities,
  type ConfigOptionUpdate,
  type ContentBlock,
  type CreateTerminalRequest,
  type CurrentModeUpdate,
  type EnvVariable,
  type InitializeResponse,
  type KillTerminalRequest,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PermissionOption,
  type Plan,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfoUpdate,
  type SessionMode,
  type SessionModelState,
  type SessionNotification,
  type SessionUpdate,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCall,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
  type Usage,
  type UsageUpdate,
  type WaitForTerminalExitRequest,
  type WriteTextFileRequest,
  type Stream as ACPStream,
} from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import {
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionRequestKind,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptContentBlock,
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
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type McpServerConfig,
  type ProviderCatalog,
  type ToolCallDetail,
  type ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnvOverlay,
} from "../../../utils/string-command-shell.js";
import { spawnProcess } from "../../../utils/spawn.js";
import {
  type DiagnosticEntry,
  toDiagnosticErrorMessage,
  truncateForDiagnostic,
} from "./diagnostic-utils.js";
import { withTimeout } from "../../../utils/promise-timeout.js";

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Child process did not expose stdio pipes");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isACPError(value: unknown): value is ACPError {
  return isRecord(value) && typeof value.message === "string" && typeof value.code === "number";
}

function extractACPErrorDataMessage(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }

  for (const key of ["details", "errorMessage", "message", "detail", "title"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return extractACPErrorDataMessage(data.error);
}

export function summarizeACPRequestError(error: unknown): {
  message: string;
  code?: string;
  diagnostic?: string;
} {
  // Promise rejections are untyped, but the ACP SDK rejects JSON-RPC failures as response.error.
  if (isACPError(error)) {
    const code = String(error.code);
    const detail = extractACPErrorDataMessage(error.data);
    const message =
      detail && detail !== error.message ? `${error.message}: ${detail}` : error.message;
    const data = error.data === undefined ? "" : ` | data=${JSON.stringify(error.data)}`;
    return {
      message,
      code,
      diagnostic: `${message} | code=${code}${data}`,
    };
  }

  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}

function toACPRequestError(error: unknown): Error {
  if (!isACPError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const summary = summarizeACPRequestError(error);
  const next = new Error(summary.message);
  next.name = "ACPRequestError";
  return next;
}

function resolveTerminalCommand(
  command: string,
  args?: string[],
): { command: string; args: string[]; shell?: boolean } {
  if (args && args.length > 0) {
    return { command, args };
  }

  if (!/\s/.test(command.trim())) {
    return { command, args: [] };
  }

  const shell = buildStringCommandShellInvocation({ command, windowsShell: "cmd" });
  return { command: shell.shell, args: shell.args, shell: false };
}

function formatDurationMs(startedAt: number): string {
  return `${Math.max(0, Date.now() - startedAt)}ms`;
}

function pushACPStderrRow(rows: DiagnosticEntry[], stderrChunks: string[]): void {
  const stderr = stderrChunks.join("").trim();
  if (!stderr) {
    return;
  }
  rows.push({
    label: "ACP stderr",
    value: truncateForDiagnostic(stderr),
  });
}

export const DEFAULT_ACP_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  // ACP agents can list prior sessions via `session/list`. The runtime probe in
  // listImportableSessions returns nothing for agents that don't advertise the
  // capability, so enabling this here only makes the daemon query them.
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const BASE_ACP_CLIENT_CAPABILITIES: ACPClientCapabilities = {
  fs: {
    readTextFile: false,
    writeTextFile: false,
  },
  terminal: false,
};

export type ACPClientCapabilityMeta = Record<string, unknown>;

export function buildACPClientCapabilities(
  meta?: ACPClientCapabilityMeta,
  override?: ACPClientCapabilities,
): ACPClientCapabilities {
  const capabilities: ACPClientCapabilities = {
    ...BASE_ACP_CLIENT_CAPABILITIES,
    ...override,
    fs: {
      ...BASE_ACP_CLIENT_CAPABILITIES.fs,
      ...override?.fs,
    },
  };
  return meta && Object.keys(meta).length > 0 ? { ...capabilities, _meta: meta } : capabilities;
}

// Suppress interactive auth side-effects (e.g. Gemini CLI opening a Google
// sign-in URL in the browser) when probing an ACP agent for models/modes.
// NO_BROWSER is honored by Gemini CLI; other ACP agents ignore it.
const PROBE_ENV: Record<string, string> = { NO_BROWSER: "true" };
const ACP_CATALOG_TIMEOUT_MS = 60_000;
const ACP_DIAGNOSTIC_PHASE_TIMEOUT_MS = 20_000;

function summarizeMalformedACPStdoutError(error: unknown): { type: string; message: string } {
  return {
    type: error instanceof Error ? error.name : typeof error,
    message: "ACP stdout line was not valid JSON",
  };
}

function normalizeACPIncomingMessage(message: AnyMessage): AnyMessage {
  if (
    "id" in message &&
    !("method" in message) &&
    typeof message.id === "string" &&
    /^\d+$/.test(message.id)
  ) {
    const numericId = Number(message.id);
    if (Number.isSafeInteger(numericId)) {
      return {
        ...message,
        // COMPAT(deepseek-tui-acp-id): added v0.1.78, remove after 2026-11-19
        // once the ACP SDK accepts stringified numeric response IDs.
        id: numericId,
      } as AnyMessage;
    }
  }
  return message;
}

export function createLoggedNdJsonStream(
  output: NodeWritableStream,
  input: NodeReadableStream,
  options: { logger: Logger; provider: string },
): ACPStream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }

          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) {
              continue;
            }

            try {
              const message: AnyMessage = JSON.parse(trimmedLine);
              controller.enqueue(normalizeACPIncomingMessage(message));
            } catch (error) {
              options.logger.warn(
                {
                  err: summarizeMalformedACPStdoutError(error),
                  provider: options.provider,
                },
                "ACP agent emitted non-JSON stdout; ignoring line",
              );
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

// Lets a provider that publishes its slash commands through a vendor-specific
// ACP extension notification (rather than the standard
// `available_commands_update` session update) translate that payload into Paseo
// slash commands, without the generic ACP session/client carrying any vendor
// knowledge. Return the parsed commands (possibly empty) for a notification this
// provider owns, or null to ignore notifications it does not handle.
export type ACPExtensionCommandsParser = (
  method: string,
  params: Record<string, unknown>,
) => AgentSlashCommand[] | null;

interface ACPAgentClientOptions {
  provider: string;
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  defaultCommand: [string, ...string[]];
  defaultModes?: AgentMode[];
  modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
  configOptionsTransformer?: (configOptions: SessionConfigOption[]) => SessionConfigOption[];
  configFeatureOptions?: ACPConfigFeatureOption[];
  clientCapabilities?: ACPClientCapabilities;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  modeIdTransformer?: (modeId: string) => string | null;
  toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  providerModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPProviderModeWriteResult>;
  beforeModeWriter?: (context: ACPProviderModeWriterContext) => Promise<ACPBeforeModeWriteResult>;
  thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  capabilities?: AgentCapabilityFlags;
  extensionCommandsParser?: ACPExtensionCommandsParser;
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
  terminateProcess?: ProcessTerminator;
}

interface ACPAgentSessionOptions {
  provider: string;
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  defaultCommand: [string, ...string[]];
  defaultModes: AgentMode[];
  modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
  configOptionsTransformer?: (configOptions: SessionConfigOption[]) => SessionConfigOption[];
  configFeatureOptions?: ACPConfigFeatureOption[];
  clientCapabilities?: ACPClientCapabilities;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  modeIdTransformer?: (modeId: string) => string | null;
  toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  providerModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPProviderModeWriteResult>;
  beforeModeWriter?: (context: ACPProviderModeWriterContext) => Promise<ACPBeforeModeWriteResult>;
  thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  capabilities: AgentCapabilityFlags;
  extensionCommandsParser?: ACPExtensionCommandsParser;
  handle?: AgentPersistenceHandle;
  agentId?: string;
  launchEnv?: Record<string, string>;
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
  terminateProcess?: ProcessTerminator;
}

export interface SpawnedACPProcess {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  initialize: InitializeResponse;
  stderrChunks?: string[];
}

type UninitializedACPProcess = Omit<SpawnedACPProcess, "initialize"> & {
  initialize?: InitializeResponse;
};

interface ACPProcessTransport {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  stderrChunks: string[];
  spawnReady: Promise<void>;
  spawnError: Promise<never>;
}

export interface ACPToolSnapshot {
  toolCallId: string;
  title: string;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
  reject: (error: Error) => void;
  turnId: string | null;
}

interface MessageAssemblyState {
  text: string;
}

interface SubmittedUserMessageEcho {
  messageId: string;
  text: string;
  turnId: string;
}

export type SessionStateResponse = NewSessionResponse | LoadSessionResponse | ResumeSessionResponse;

interface TerminalExit {
  exitCode?: number | null;
  signal?: string | null;
}

interface TerminalEntry {
  id: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number | null;
  exit: TerminalExit | null;
  waitForExit: Promise<TerminalExit>;
  resolveExit: (exit: TerminalExit) => void;
  rejectExit: (error: Error) => void;
}

interface ConfigOptionSelector {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export interface ACPConfigFeatureOption {
  id: string;
  configId: string;
  category?: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  emptyOptionLabel?: string;
}

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;
interface SelectConfigChoice {
  value: string;
  name: string;
  description?: string | null;
  group?: string;
}
type AvailableACPModel = NonNullable<SessionModelState["availableModels"]>[number];

interface ACPModeSelection {
  availableMode: AgentMode | null;
  configOption: SelectConfigOption | null;
  configChoice: SelectConfigChoice | null;
  hasAvailableModes: boolean;
}

interface ACPModelSelection {
  availableModel: AvailableACPModel | null;
  configOption: SelectConfigOption | null;
  configChoice: SelectConfigChoice | null;
  hasAvailableModels: boolean;
}

export interface ACPProviderModeWriterContext {
  connection: ClientSideConnection;
  sessionId: string;
  requestedModeId: string;
  currentModeId: string | null;
  selection: ACPModeSelection;
  configOptions: SessionConfigOption[];
  logger: Logger;
}

export interface ACPProviderModeWriteResult {
  handled: boolean;
  currentModeId?: string;
  configOptions?: SessionConfigOption[];
}

export interface ACPBeforeModeWriteResult {
  configOptions?: SessionConfigOption[];
}

export function mapACPUsage(usage: Usage | null | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
    cachedInputTokens: usage.cachedReadTokens ?? undefined,
  };
}

export function resolveACPModeSelection({
  modeId,
  availableModes,
  configOptions,
}: {
  modeId: string;
  availableModes: AgentMode[];
  configOptions: SessionConfigOption[] | null | undefined;
}): ACPModeSelection {
  const configOption = findSelectConfigOption({ configOptions, category: "mode" });
  return {
    availableMode: availableModes.find((mode) => mode.id === modeId) ?? null,
    configOption,
    configChoice: findSelectConfigChoice({ option: configOption, value: modeId }),
    hasAvailableModes: availableModes.length > 0,
  };
}

export function resolveACPModelSelection({
  modelId,
  availableModels,
  configOptions,
}: {
  modelId: string;
  availableModels: AvailableACPModel[] | null | undefined;
  configOptions: SessionConfigOption[] | null | undefined;
}): ACPModelSelection {
  const configOption = findSelectConfigOption({ configOptions, category: "model" });
  return {
    availableModel: availableModels?.find((model) => model.modelId === modelId) ?? null,
    configOption,
    configChoice: findSelectConfigChoice({ option: configOption, value: modelId }),
    hasAvailableModels: Boolean(availableModels?.length),
  };
}

export function deriveModesFromACP(
  fallbackModes: AgentMode[],
  modeState?: { availableModes?: SessionMode[] | null; currentModeId?: string | null } | null,
  configOptions?: SessionConfigOption[] | null,
): { modes: AgentMode[]; currentModeId: string | null } {
  if (modeState?.availableModes?.length) {
    return {
      modes: modeState.availableModes.map((mode) => ({
        id: mode.id,
        label: mode.name,
        description: mode.description ?? undefined,
      })),
      currentModeId: modeState.currentModeId ?? null,
    };
  }

  const modeOption = findSelectConfigOption({ configOptions, category: "mode" });
  if (modeOption) {
    const flatOptions = flattenSelectOptions(modeOption.options);
    return {
      modes: flatOptions.map((option) => ({
        id: option.value,
        label: option.name,
        description: option.description ?? undefined,
      })),
      currentModeId: modeOption.currentValue,
    };
  }

  return {
    modes: fallbackModes,
    currentModeId: null,
  };
}

export function deriveModelDefinitionsFromACP(
  provider: string,
  models: SessionModelState | null | undefined,
  configOptions?: SessionConfigOption[] | null,
): AgentModelDefinition[] {
  const thinkingOptions = deriveSelectorOptions(configOptions, "thought_level");
  const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id ?? null;

  if (models?.availableModels?.length) {
    return models.availableModels.map((model) => ({
      provider,
      id: model.modelId,
      label: model.name,
      description: model.description ?? undefined,
      isDefault: model.modelId === models.currentModelId,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId: defaultThinkingOptionId ?? undefined,
    }));
  }

  const modelOptions = deriveSelectorOptions(configOptions, "model");
  return modelOptions.map((option) => ({
    provider,
    id: option.id,
    label: option.label,
    description: option.description,
    isDefault: option.isDefault,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId: defaultThinkingOptionId ?? undefined,
    metadata: option.metadata,
  }));
}

export function deriveFeaturesFromACP(
  configOptions: SessionConfigOption[] | null | undefined,
  featureOptions: ACPConfigFeatureOption[],
): AgentFeature[] {
  return featureOptions.flatMap((featureOption) => {
    const option = findSelectConfigFeatureOption(configOptions, featureOption);
    if (!option) {
      return [];
    }

    return [
      {
        type: "select",
        id: featureOption.id,
        label: featureOption.label,
        description: featureOption.description,
        tooltip: featureOption.tooltip,
        icon: featureOption.icon,
        value: option.currentValue ?? null,
        options: deriveConfigFeatureSelectOptions(option, featureOption),
      },
    ];
  });
}

export class ACPAgentClient implements AgentClient {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  protected readonly logger: Logger;
  protected readonly runtimeSettings?: ProviderRuntimeSettings;
  protected readonly defaultCommand: [string, ...string[]];
  protected readonly defaultModes: AgentMode[];
  private readonly modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  private readonly sessionResponseTransformer?: (
    response: SessionStateResponse,
  ) => SessionStateResponse;
  private readonly configOptionsTransformer?: (
    configOptions: SessionConfigOption[],
  ) => SessionConfigOption[];
  private readonly configFeatureOptions: ACPConfigFeatureOption[];
  private readonly clientCapabilities?: ACPClientCapabilities;
  private readonly clientCapabilityMeta?: ACPClientCapabilityMeta;
  private readonly modeIdTransformer?: (modeId: string) => string | null;
  private readonly toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  private readonly providerModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPProviderModeWriteResult>;
  private readonly beforeModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPBeforeModeWriteResult>;
  private readonly thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  private readonly waitForInitialCommands: boolean;
  private readonly initialCommandsWaitTimeoutMs: number;
  private readonly extensionCommandsParser?: ACPExtensionCommandsParser;
  protected readonly terminateProcess: ProcessTerminator;

  constructor(options: ACPAgentClientOptions) {
    this.provider = options.provider;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.capabilities = options.capabilities ?? DEFAULT_ACP_CAPABILITIES;
    this.logger = options.logger.child({
      module: "agent",
      provider: options.provider,
    });
    this.runtimeSettings = options.runtimeSettings;
    this.defaultCommand = options.defaultCommand;
    this.defaultModes = options.defaultModes ?? [];
    this.modelTransformer = options.modelTransformer;
    this.sessionResponseTransformer = options.sessionResponseTransformer;
    this.configOptionsTransformer = options.configOptionsTransformer;
    this.configFeatureOptions = options.configFeatureOptions ?? [];
    this.clientCapabilities = options.clientCapabilities;
    this.clientCapabilityMeta = options.clientCapabilityMeta;
    this.modeIdTransformer = options.modeIdTransformer;
    this.toolSnapshotTransformer = options.toolSnapshotTransformer;
    this.providerModeWriter = options.providerModeWriter;
    this.beforeModeWriter = options.beforeModeWriter;
    this.thinkingOptionWriter = options.thinkingOptionWriter;
    this.waitForInitialCommands = options.waitForInitialCommands ?? false;
    this.initialCommandsWaitTimeoutMs = options.initialCommandsWaitTimeoutMs ?? 1500;
    this.extensionCommandsParser = options.extensionCommandsParser;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.assertProvider(config);
    const session = new ACPAgentSession(
      { ...config, provider: this.provider },
      {
        provider: this.provider,
        logger: this.logger,
        runtimeSettings: this.runtimeSettings,
        defaultCommand: this.defaultCommand,
        defaultModes: this.defaultModes,
        modelTransformer: this.modelTransformer,
        sessionResponseTransformer: this.sessionResponseTransformer,
        configOptionsTransformer: this.configOptionsTransformer,
        configFeatureOptions: this.configFeatureOptions,
        clientCapabilities: this.clientCapabilities,
        clientCapabilityMeta: this.clientCapabilityMeta,
        modeIdTransformer: this.modeIdTransformer,
        toolSnapshotTransformer: this.toolSnapshotTransformer,
        providerModeWriter: this.providerModeWriter,
        beforeModeWriter: this.beforeModeWriter,
        thinkingOptionWriter: this.thinkingOptionWriter,
        capabilities: this.capabilities,
        agentId: launchContext?.agentId,
        launchEnv: launchContext?.env,
        extensionCommandsParser: this.extensionCommandsParser,
        waitForInitialCommands: this.waitForInitialCommands,
        initialCommandsWaitTimeoutMs: this.initialCommandsWaitTimeoutMs,
      },
    );
    await session.initializeNewSession();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    if (handle.provider !== this.provider) {
      throw new Error(`Cannot resume ${handle.provider} handle with ${this.provider} provider`);
    }

    const storedConfig = coerceSessionConfigMetadata(handle.metadata);
    const cwd = overrides?.cwd ?? storedConfig.cwd;
    if (!cwd) {
      throw new Error(`${this.provider} resume requires the original working directory`);
    }

    const mergedConfig: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: this.provider,
      cwd,
    };
    const session = new ACPAgentSession(mergedConfig, {
      provider: this.provider,
      logger: this.logger,
      runtimeSettings: this.runtimeSettings,
      defaultCommand: this.defaultCommand,
      defaultModes: this.defaultModes,
      modelTransformer: this.modelTransformer,
      sessionResponseTransformer: this.sessionResponseTransformer,
      configOptionsTransformer: this.configOptionsTransformer,
      configFeatureOptions: this.configFeatureOptions,
      clientCapabilities: this.clientCapabilities,
      clientCapabilityMeta: this.clientCapabilityMeta,
      modeIdTransformer: this.modeIdTransformer,
      toolSnapshotTransformer: this.toolSnapshotTransformer,
      providerModeWriter: this.providerModeWriter,
      beforeModeWriter: this.beforeModeWriter,
      thinkingOptionWriter: this.thinkingOptionWriter,
      capabilities: this.capabilities,
      handle,
      agentId: launchContext?.agentId,
      launchEnv: launchContext?.env,
      extensionCommandsParser: this.extensionCommandsParser,
      waitForInitialCommands: this.waitForInitialCommands,
      initialCommandsWaitTimeoutMs: this.initialCommandsWaitTimeoutMs,
    });
    await session.initializeResumedSession();
    return session;
  }

  async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const cwd = options.scope === "global" ? homedir() : options.cwd;
    const timeoutMs = options.timeoutMs ?? ACP_CATALOG_TIMEOUT_MS;
    let probe: UninitializedACPProcess | null = null;
    try {
      const catalogProbe = (async () => {
        const initializedProbe = await this.spawnProcess(PROBE_ENV, {
          initializeTimeoutMs: timeoutMs,
          onSpawned: (spawned) => {
            probe = spawned;
          },
        });
        probe = initializedProbe;
        const response = await this.runACPRequest(() =>
          initializedProbe.connection.newSession({
            cwd,
            mcpServers: [],
          }),
        );
        const transformed = this.transformSessionResponse(response);
        const models = deriveModelDefinitionsFromACP(
          this.provider,
          transformed.models,
          transformed.configOptions,
        );
        const modeInfo = deriveModesFromACP(
          this.defaultModes,
          transformed.modes,
          transformed.configOptions,
        );
        return {
          models: this.modelTransformer ? this.modelTransformer(models) : models,
          modes: modeInfo.modes,
        };
      })();

      return await withTimeout(
        catalogProbe,
        timeoutMs,
        `ACP catalog probe timed out after ${timeoutMs}ms`,
      );
    } finally {
      if (probe) {
        await this.closeProbe(probe);
      }
    }
  }

  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    if (this.configFeatureOptions.length === 0) {
      return [];
    }

    this.assertProvider(config);
    const probe = await this.spawnProcess(PROBE_ENV);
    try {
      const response = await this.runACPRequest(() =>
        probe.connection.newSession({
          cwd: config.cwd,
          mcpServers: [],
        }),
      );
      const transformed = this.transformSessionResponse(response);
      return deriveFeaturesFromACP(transformed.configOptions, this.configFeatureOptions);
    } finally {
      await this.closeProbe(probe);
    }
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    const probe = await this.spawnProcess(PROBE_ENV);
    try {
      if (!probe.initialize.agentCapabilities?.sessionCapabilities?.list) {
        return [];
      }

      const sessions: ImportableProviderSession[] = [];
      let cursor: string | null | undefined;
      for (;;) {
        const page: ListSessionsResponse = await this.runACPRequest(() =>
          probe.connection.listSessions({
            ...(cursor ? { cursor } : {}),
            // Filter by working directory at the source. Without this the agent
            // returns globally-recent sessions, which the `limit` below can
            // truncate before the current directory's sessions are reached.
            ...(options?.cwd ? { cwd: options.cwd } : {}),
          }),
        );
        for (const session of page.sessions) {
          sessions.push({
            providerHandleId: session.sessionId,
            cwd: session.cwd,
            title: session.title ?? null,
            firstPromptPreview: null,
            lastPromptPreview: null,
            lastActivityAt: session.updatedAt ? new Date(session.updatedAt) : new Date(0),
          });
        }
        cursor = page.nextCursor ?? null;
        if (!cursor) break;
        if (options?.limit && sessions.length >= options.limit) break;
      }

      return typeof options?.limit === "number" ? sessions.slice(0, options.limit) : sessions;
    } finally {
      await this.closeProbe(probe);
    }
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.resolveLaunchCommand();
      return true;
    } catch {
      return false;
    }
  }

  protected async spawnProcess(
    launchEnv?: Record<string, string>,
    options?: {
      initializeTimeoutMs?: number;
      onSpawned?: (probe: UninitializedACPProcess) => void;
    },
  ): Promise<SpawnedACPProcess> {
    const transport = await this.spawnTransport(launchEnv);
    const probe: UninitializedACPProcess = {
      child: transport.child,
      connection: transport.connection,
      stderrChunks: transport.stderrChunks,
    };
    options?.onSpawned?.(probe);
    try {
      const initialize = await this.initializeTransport(transport, options?.initializeTimeoutMs);
      const initializedProbe: SpawnedACPProcess = {
        ...probe,
        initialize,
      };
      probe.initialize = initialize;
      return initializedProbe;
    } catch (error) {
      await terminateChildProcess(transport.child, 2_000, this.terminateProcess);
      throw error;
    }
  }

  protected async spawnTransport(launchEnv?: Record<string, string>): Promise<ACPProcessTransport> {
    const { command, args } = await this.resolveLaunchCommand();
    const child = spawnProcess(command, args, {
      cwd: process.cwd(),
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv],
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    assertChildWithPipes(child);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        const stderr = stderrChunks.join("").trim();
        reject(new Error(stderr ? `${String(error)}\n${stderr}` : String(error)));
      });
    });
    const spawnReadyPromise = new Promise<void>((resolve) => {
      child.once("spawn", () => {
        resolve();
      });
    });

    const stream = createLoggedNdJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
      { logger: this.logger, provider: this.provider },
    );
    const connection = new ClientSideConnection(() => this.buildProbeClient(), stream);

    return {
      child,
      connection,
      stderrChunks,
      spawnReady: spawnReadyPromise,
      spawnError: spawnErrorPromise,
    };
  }

  protected async initializeTransport(
    transport: ACPProcessTransport,
    initializeTimeoutMs?: number,
  ): Promise<InitializeResponse> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const initializeTimeoutPromise = initializeTimeoutMs
      ? new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`ACP initialize timed out after ${initializeTimeoutMs}ms`));
          }, initializeTimeoutMs);
        })
      : null;

    try {
      return await this.runACPRequest(() =>
        Promise.race([
          transport.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: buildACPClientCapabilities(
              this.clientCapabilityMeta,
              this.clientCapabilities,
            ),
            clientInfo: { name: "Paseo", version: "dev" },
          }),
          transport.spawnError,
          ...(initializeTimeoutPromise ? [initializeTimeoutPromise] : []),
        ]),
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  protected buildProbeClient(): ACPClient {
    return {
      async requestPermission(): Promise<RequestPermissionResponse> {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(): Promise<void> {},
      async readTextFile(params: ReadTextFileRequest) {
        const content = await fs.readFile(params.path, "utf8");
        return { content };
      },
      async writeTextFile(params: WriteTextFileRequest) {
        await fs.mkdir(path.dirname(params.path), { recursive: true });
        await fs.writeFile(params.path, params.content, "utf8");
        return {};
      },
      async createTerminal() {
        throw new Error("ACP model probe does not support terminal execution");
      },
    };
  }

  protected async closeProbe(probe: UninitializedACPProcess): Promise<void> {
    try {
      if (probe.initialize?.agentCapabilities?.sessionCapabilities?.close) {
        // No active session to close here; ignore capability.
      }
    } finally {
      await terminateChildProcess(probe.child, 2_000, this.terminateProcess);
    }
  }

  protected async runACPRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw toACPRequestError(error);
    }
  }

  protected async buildACPProbeDiagnosticRows(
    options: {
      cwd?: string;
      phaseTimeoutMs?: number;
    } = {},
  ): Promise<DiagnosticEntry[]> {
    const rows: DiagnosticEntry[] = [];
    const phaseTimeoutMs = options.phaseTimeoutMs ?? ACP_DIAGNOSTIC_PHASE_TIMEOUT_MS;
    const cwd = options.cwd ?? homedir();
    let transport: ACPProcessTransport | null = null;

    try {
      const spawnStartedAt = Date.now();
      try {
        transport = await this.spawnTransport(PROBE_ENV);
        await withTimeout(
          Promise.race([transport.spawnReady, transport.spawnError]),
          phaseTimeoutMs,
          `ACP spawn timed out after ${phaseTimeoutMs}ms`,
        );
        rows.push({
          label: "ACP spawn",
          value: `ok (${formatDurationMs(spawnStartedAt)})`,
        });
      } catch (error) {
        rows.push({
          label: "ACP spawn",
          value: `error: ${toDiagnosticErrorMessage(error)}`,
        });
        return rows;
      }
      const activeTransport = transport;

      const initializeStartedAt = Date.now();
      try {
        await this.initializeTransport(activeTransport, phaseTimeoutMs);
        rows.push({
          label: "ACP initialize",
          value: `ok (${formatDurationMs(initializeStartedAt)})`,
        });
      } catch (error) {
        rows.push({
          label: "ACP initialize",
          value: `error: ${toDiagnosticErrorMessage(error)}`,
        });
        pushACPStderrRow(rows, activeTransport.stderrChunks);
        return rows;
      }

      const sessionStartedAt = Date.now();
      try {
        const response = await withTimeout(
          this.runACPRequest(() =>
            activeTransport.connection.newSession({
              cwd,
              mcpServers: [],
            }),
          ),
          phaseTimeoutMs,
          `ACP session/new timed out after ${phaseTimeoutMs}ms`,
        );
        const transformed = this.transformSessionResponse(response);
        const models = deriveModelDefinitionsFromACP(
          this.provider,
          transformed.models,
          transformed.configOptions,
        );
        const modeInfo = deriveModesFromACP(
          this.defaultModes,
          transformed.modes,
          transformed.configOptions,
        );
        rows.push({
          label: "ACP session/new",
          value: `ok (${formatDurationMs(sessionStartedAt)}; models=${models.length}; modes=${
            modeInfo.modes.length
          })`,
        });
      } catch (error) {
        rows.push({
          label: "ACP session/new",
          value: `error: ${toDiagnosticErrorMessage(error)}`,
        });
        pushACPStderrRow(rows, activeTransport.stderrChunks);
        return rows;
      }

      pushACPStderrRow(rows, activeTransport.stderrChunks);
      return rows;
    } finally {
      if (transport) {
        const cleanupStartedAt = Date.now();
        try {
          await terminateChildProcess(transport.child, 2_000, this.terminateProcess);
          rows.push({
            label: "ACP cleanup",
            value: `ok (${formatDurationMs(cleanupStartedAt)})`,
          });
        } catch (error) {
          rows.push({
            label: "ACP cleanup",
            value: `error: ${toDiagnosticErrorMessage(error)}`,
          });
        }
      }
    }
  }

  protected async resolveLaunchCommand(): Promise<{ command: string; args: string[] }> {
    const prefix = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: this.defaultCommand[0],
    });
    const availability = await checkProviderLaunchAvailable(prefix);
    if (!availability.available) {
      throw new Error(`${this.provider} command '${this.defaultCommand[0]}' not found`);
    }
    return {
      command: prefix.command,
      args: [...prefix.args, ...this.defaultCommand.slice(1)],
    };
  }

  private assertProvider(config: AgentSessionConfig): void {
    if (config.provider !== this.provider) {
      throw new Error(`Expected ${this.provider} config, received ${config.provider}`);
    }
  }

  protected transformSessionResponse(response: SessionStateResponse): SessionStateResponse {
    const transformed = this.sessionResponseTransformer
      ? this.sessionResponseTransformer(response)
      : response;
    if (!this.configOptionsTransformer || !transformed.configOptions) {
      return transformed;
    }
    return {
      ...transformed,
      configOptions: this.configOptionsTransformer(transformed.configOptions),
    };
  }
}

export class ACPAgentSession implements AgentSession, ACPClient {
  readonly provider: string;
  readonly capabilities: AgentCapabilityFlags;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly defaultCommand: [string, ...string[]];
  private readonly defaultModes: AgentMode[];
  protected readonly modelTransformer?: (models: AgentModelDefinition[]) => AgentModelDefinition[];
  private readonly sessionResponseTransformer?: (
    response: SessionStateResponse,
  ) => SessionStateResponse;
  private readonly configOptionsTransformer?: (
    configOptions: SessionConfigOption[],
  ) => SessionConfigOption[];
  private readonly configFeatureOptions: ACPConfigFeatureOption[];
  private readonly clientCapabilities?: ACPClientCapabilities;
  private readonly clientCapabilityMeta?: ACPClientCapabilityMeta;
  private readonly modeIdTransformer?: (modeId: string) => string | null;
  private readonly toolSnapshotTransformer?: (snapshot: ACPToolSnapshot) => ACPToolSnapshot;
  private readonly providerModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPProviderModeWriteResult>;
  private readonly beforeModeWriter?: (
    context: ACPProviderModeWriterContext,
  ) => Promise<ACPBeforeModeWriteResult>;
  private readonly thinkingOptionWriter?: (
    connection: ClientSideConnection,
    sessionId: string,
    thinkingOptionId: string,
  ) => Promise<void>;
  private readonly agentId?: string;
  private readonly launchEnv?: Record<string, string>;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly messageAssemblies = new Map<string, MessageAssemblyState>();
  private readonly submittedUserMessageIds = new Set<string>();
  private activeSubmittedUserMessage: SubmittedUserMessageEcho | null = null;
  private readonly toolCalls = new Map<string, ACPToolSnapshot>();
  private readonly terminalEntries = new Map<string, TerminalEntry>();
  private readonly persistedHistory: AgentTimelineItem[] = [];
  private readonly initialHandle?: AgentPersistenceHandle;

  private readonly config: AgentSessionConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private agentCapabilities: ACPAgentCapabilities | null = null;
  private sessionId: string | null = null;
  private currentMode: string | null = null;
  private availableModes: AgentMode[];
  private currentModel: string | null = null;
  private availableModels: AvailableACPModel[] | null = null;
  private thinkingOptionId: string | null = null;
  private currentTitle: string | null = null;
  private lastActivityAt: string | null = null;
  private configOptions: SessionConfigOption[] = [];
  private cachedCommands: AgentSlashCommand[] = [];
  private commandsReadyDeferred: { promise: Promise<void>; resolve: () => void } | null = null;
  private commandsReadySettled = false;
  private waitForInitialCommands: boolean;
  private initialCommandsWaitTimeoutMs: number;
  private readonly extensionCommandsParser?: ACPExtensionCommandsParser;
  private currentTurnUsage: AgentUsage | undefined;
  private activeForegroundTurnId: string | null = null;
  private fallbackAssistantMessageId: string | null = null;
  private closed = false;
  private historyPending = false;
  private replayingHistory = false;
  private bootstrapThreadEventPending = false;
  private readonly terminateProcess: ProcessTerminator;

  constructor(config: AgentSessionConfig, options: ACPAgentSessionOptions) {
    this.provider = options.provider;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.capabilities = options.capabilities;
    this.logger = options.logger.child({ module: "agent", provider: options.provider });
    this.runtimeSettings = options.runtimeSettings;
    this.defaultCommand = options.defaultCommand;
    this.defaultModes = options.defaultModes;
    this.modelTransformer = options.modelTransformer;
    this.sessionResponseTransformer = options.sessionResponseTransformer;
    this.configOptionsTransformer = options.configOptionsTransformer;
    this.configFeatureOptions = options.configFeatureOptions ?? [];
    this.clientCapabilities = options.clientCapabilities;
    this.clientCapabilityMeta = options.clientCapabilityMeta;
    this.modeIdTransformer = options.modeIdTransformer;
    this.toolSnapshotTransformer = options.toolSnapshotTransformer;
    this.providerModeWriter = options.providerModeWriter;
    this.beforeModeWriter = options.beforeModeWriter;
    this.thinkingOptionWriter = options.thinkingOptionWriter;
    this.availableModes = options.defaultModes;
    this.agentId = options.agentId;
    this.launchEnv = options.launchEnv;
    this.initialHandle = options.handle;
    this.config = { ...config, provider: options.provider };
    this.currentMode = config.modeId ?? null;
    this.currentModel = config.model ?? null;
    this.thinkingOptionId = config.thinkingOptionId ?? null;
    this.currentTitle = config.title ?? null;
    this.waitForInitialCommands = options.waitForInitialCommands ?? false;
    this.initialCommandsWaitTimeoutMs = options.initialCommandsWaitTimeoutMs ?? 1500;
    this.extensionCommandsParser = options.extensionCommandsParser;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async initializeNewSession(): Promise<void> {
    const spawned = await this.spawnProcess();
    this.child = spawned.child;
    this.connection = spawned.connection;
    this.agentCapabilities = spawned.initialize.agentCapabilities ?? null;

    const response = await this.runACPRequest(() =>
      this.connection!.newSession({
        cwd: this.config.cwd,
        mcpServers: this.acpMcpServers(),
      }),
    );
    this.sessionId = response.sessionId;
    this.bootstrapThreadEventPending = true;
    this.applySessionState(response);
    await this.applyConfiguredOverrides();
  }

  /**
   * IMPORTANT: Some ACP providers (e.g., Devin CLI) require all three params
   * (sessionId, cwd, mcpServers) to be present in session/load or
   * unstable_resumeSession — even when mcpServers is an empty array — and
   * return "Invalid params" if any are omitted. Never drop cwd or mcpServers
   * from these calls regardless of capabilities.
   */
  async initializeResumedSession(): Promise<void> {
    const handle = this.initialHandle;
    if (!handle) {
      throw new Error("Resume requested without persistence handle");
    }

    const spawned = await this.spawnProcess();
    this.child = spawned.child;
    this.connection = spawned.connection;
    this.agentCapabilities = spawned.initialize.agentCapabilities ?? null;
    this.sessionId = handle.sessionId;
    this.bootstrapThreadEventPending = true;

    const sessionCapabilities = this.agentCapabilities?.sessionCapabilities;
    if (this.agentCapabilities?.loadSession) {
      this.replayingHistory = true;
      const response = await this.runACPRequest(() =>
        this.connection!.loadSession({
          sessionId: handle.sessionId,
          cwd: this.config.cwd,
          mcpServers: this.acpMcpServers(),
        }),
      );
      this.replayingHistory = false;
      this.historyPending = this.persistedHistory.length > 0;
      this.applySessionState(response);
    } else if (sessionCapabilities?.resume) {
      const response = await this.runACPRequest(() =>
        this.connection!.unstable_resumeSession({
          sessionId: handle.sessionId,
          cwd: this.config.cwd,
          mcpServers: this.acpMcpServers(),
        }),
      );
      this.applySessionState(response);
    } else {
      throw new Error(`${this.provider} does not support ACP session resume`);
    }

    await this.applyConfiguredOverrides();
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const result = await runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionId ?? "",
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });

    if (!this.sessionId) {
      throw new Error("ACP session did not expose a session id");
    }

    return result;
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error(`${this.provider} session is closed`);
    }
    if (!this.connection || !this.sessionId) {
      throw new Error(`${this.provider} session is not initialized`);
    }
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    const turnId = randomUUID();
    const messageId = options?.messageId ?? randomUUID();
    this.activeForegroundTurnId = turnId;
    this.fallbackAssistantMessageId = null;
    this.activeSubmittedUserMessage = null;
    this.emitBootstrapThreadEvent();
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
    this.emitSubmittedUserMessage(prompt, messageId, turnId);

    void this.connection
      .prompt({
        sessionId: this.sessionId,
        messageId,
        prompt: toACPContentBlocks(prompt),
      })
      .then((response) => {
        this.handlePromptResponse(response, turnId);
        return;
      })
      .catch((error) => {
        const summary = summarizeACPRequestError(error);
        this.finishTurn({
          type: "turn_failed",
          provider: this.provider,
          error: summary.message,
          code: summary.code,
          diagnostic: this.collectDiagnostic(summary.diagnostic ?? summary.message),
          turnId,
        });
      });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.sessionId) {
      callback({
        type: "thread_started",
        provider: this.provider,
        sessionId: this.sessionId,
      });
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.historyPending || this.persistedHistory.length === 0) {
      return;
    }
    const history = [...this.persistedHistory];
    this.persistedHistory.length = 0;
    this.historyPending = false;
    for (const item of history) {
      yield { type: "timeline", provider: this.provider, item };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return this.runtimeInfo();
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...this.availableModes];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  get features(): AgentFeature[] {
    return deriveFeaturesFromACP(this.configOptions, this.configFeatureOptions);
  }

  private ensureCommandsReadyDeferred(): void {
    if (this.commandsReadyDeferred || this.commandsReadySettled || this.cachedCommands.length > 0) {
      return;
    }

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.commandsReadyDeferred = { promise, resolve };
  }

  private settleCommandsReady(): void {
    if (this.commandsReadySettled) {
      return;
    }
    this.commandsReadySettled = true;
    this.commandsReadyDeferred?.resolve();
    this.commandsReadyDeferred = null;
  }

  private async waitForCommandsReady(): Promise<void> {
    const deferred = this.commandsReadyDeferred;
    if (!deferred) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        deferred.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.initialCommandsWaitTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    if (this.cachedCommands.length > 0) {
      return this.cachedCommands;
    }
    if (!this.waitForInitialCommands || this.closed) {
      return this.cachedCommands;
    }

    this.ensureCommandsReadyDeferred();
    await this.waitForCommandsReady();
    this.settleCommandsReady();
    return this.cachedCommands;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    const selection = resolveACPModeSelection({
      modeId,
      availableModes: this.availableModes,
      configOptions: this.configOptions,
    });
    await this.setModeWithSelection({ modeId, selection });
  }

  // Mode/model selection updates stay after ACP RPC success; this intentionally diverges from Zed's optimistic rollback path (acp.rs:3080-3104).
  private async setModeWithSelection({
    modeId,
    selection,
  }: {
    modeId: string;
    selection: ACPModeSelection;
  }): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    const context = this.createProviderModeWriterContext(modeId, selection);
    const providerResult = this.providerModeWriter
      ? await this.providerModeWriter(context)
      : { handled: false };
    if (providerResult.handled) {
      this.currentMode = providerResult.currentModeId ?? modeId;
      if (providerResult.configOptions) {
        this.configOptions = this.transformConfigOptions(providerResult.configOptions);
      }
      this.availableModes = deriveModesFromACP(this.defaultModes, null, this.configOptions).modes;
      this.pushEvent({
        type: "mode_changed",
        provider: this.provider,
        currentModeId: this.currentMode,
        availableModes: [...this.availableModes],
      });
      return;
    }

    if (selection.hasAvailableModes) {
      if (!selection.availableMode) {
        this.warnInvalidSelection(
          modeId,
          `is not valid ${this.provider} mode. Available options: ${this.availableModes
            .map((mode) => mode.id)
            .join(", ")}`,
        );
        return;
      }
    } else {
      const modeOption = selection.configOption;
      if (!modeOption) {
        throw new Error(`${this.provider} does not expose ACP mode switching`);
      }
      if (!selection.configChoice) {
        this.warnInvalidSelection(
          modeId,
          `is not valid ${this.provider} mode config option. Available options: ${flattenSelectOptions(
            modeOption.options,
          )
            .map((option) => option.value)
            .join(", ")}`,
        );
        return;
      }
    }

    if (this.beforeModeWriter) {
      const beforeResult = await this.beforeModeWriter(context);
      if (beforeResult?.configOptions) {
        this.configOptions = this.transformConfigOptions(beforeResult.configOptions);
      }
    }

    if (selection.hasAvailableModes) {
      await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
      this.currentMode = modeId;
      this.pushEvent({
        type: "mode_changed",
        provider: this.provider,
        currentModeId: this.currentMode,
        availableModes: [...this.availableModes],
      });
      return;
    }

    const modeOption = selection.configOption;
    if (!modeOption) {
      throw new Error(`${this.provider} does not expose ACP mode switching`);
    }

    const response = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: modeOption.id,
      value: modeId,
    });
    this.currentMode = this.applyConfigOptionResponse({
      response,
      configId: modeOption.id,
      category: "mode",
      requestedValue: modeId,
      label: "mode",
    });
    this.availableModes = deriveModesFromACP(this.defaultModes, null, this.configOptions).modes;
    this.pushEvent({
      type: "mode_changed",
      provider: this.provider,
      currentModeId: this.currentMode,
      availableModes: [...this.availableModes],
    });
  }

  private createProviderModeWriterContext(
    requestedModeId: string,
    selection: ACPModeSelection,
  ): ACPProviderModeWriterContext {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }
    return {
      connection: this.connection,
      sessionId: this.sessionId,
      requestedModeId,
      currentModeId: this.currentMode,
      selection,
      configOptions: this.configOptions,
      logger: this.logger,
    };
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }
    if (!modelId) {
      this.currentModel = null;
      return;
    }

    const selection = resolveACPModelSelection({
      modelId,
      availableModels: this.availableModels,
      configOptions: this.configOptions,
    });
    await this.setModelWithSelection({ modelId, selection });
  }

  private async setModelWithSelection({
    modelId,
    selection,
  }: {
    modelId: string;
    selection: ACPModelSelection;
  }): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    if (selection.hasAvailableModels) {
      if (!selection.availableModel) {
        this.warnInvalidSelection(
          modelId,
          `is not a valid ${this.provider} model. Available options: ${this.availableModels
            ?.map((model) => model.modelId)
            .join(", ")}`,
        );
        return;
      }

      if (typeof this.connection.unstable_setSessionModel !== "function") {
        throw new Error(this.modelSelectionUnavailableMessage());
      }

      try {
        await this.connection.unstable_setSessionModel({
          sessionId: this.sessionId,
          modelId,
        });
        this.currentModel = modelId;
        this.pushEvent({
          type: "model_changed",
          provider: this.provider,
          runtimeInfo: this.runtimeInfo(),
        });
        return;
      } catch {
        // Fall through to config option path.
      }
    }

    const modelOption = selection.configOption;
    if (!modelOption) {
      throw new Error(this.modelSelectionUnavailableMessage());
    }
    if (!selection.configChoice) {
      this.warnInvalidSelection(
        modelId,
        `is not a valid ${this.provider} model config option. Available options: ${flattenSelectOptions(
          modelOption.options,
        )
          .map((option) => option.value)
          .join(", ")}`,
      );
      return;
    }

    const response = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: modelOption.id,
      value: modelId,
    });
    this.currentModel = this.applyConfigOptionResponse({
      response,
      configId: modelOption.id,
      category: "model",
      requestedValue: modelId,
      label: "model",
    });
    this.pushEvent({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: this.runtimeInfo(),
    });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }
    if (!thinkingOptionId) {
      this.thinkingOptionId = null;
      return;
    }

    if (this.thinkingOptionWriter) {
      await this.thinkingOptionWriter(this.connection, this.sessionId, thinkingOptionId);
      this.thinkingOptionId = thinkingOptionId;
      this.pushEvent({
        type: "thinking_option_changed",
        provider: this.provider,
        thinkingOptionId: this.thinkingOptionId,
      });
      return;
    }

    const option = findSelectConfigOption({
      configOptions: this.configOptions,
      category: "thought_level",
    });
    if (!option) {
      throw new Error(`${this.provider} does not expose ACP thought-level selection`);
    }
    const response = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: option.id,
      value: thinkingOptionId,
    });
    this.thinkingOptionId = this.applyConfigOptionResponse({
      response,
      configId: option.id,
      category: "thought_level",
      requestedValue: thinkingOptionId,
      label: "thought-level",
    });
    this.pushEvent({
      type: "thinking_option_changed",
      provider: this.provider,
      thinkingOptionId: this.thinkingOptionId,
    });
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error("ACP session not initialized");
    }

    const featureOption = this.configFeatureOptions.find((option) => option.id === featureId);
    if (!featureOption) {
      throw new Error(`Unknown ${this.provider} feature: ${featureId}`);
    }

    const option = findSelectConfigFeatureOption(this.configOptions, featureOption);
    if (!option) {
      throw new Error(`${this.provider} does not expose ACP feature '${featureId}'`);
    }

    const requestedValue = normalizeConfigFeatureValue(value);
    const choice = findSelectConfigChoice({ option, value: requestedValue });
    if (!choice) {
      throw new Error(
        `${this.provider} feature '${featureId}' does not include option '${requestedValue}'`,
      );
    }

    const response = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: option.id,
      value: requestedValue,
    });
    const currentValue = this.applyConfigOptionResponse({
      response,
      configId: option.id,
      category: featureOption.category,
      requestedValue,
      label: featureOption.label,
    });
    this.config.featureValues = { ...this.config.featureValues, [featureId]: currentValue };
  }

  private applyConfigOptionResponse({
    response,
    configId,
    category,
    requestedValue,
    label,
  }: {
    response: { configOptions: SessionConfigOption[] };
    configId: string;
    category?: string;
    requestedValue: string;
    label: string;
  }): string {
    this.configOptions = this.transformConfigOptions(response.configOptions);
    const responseOption =
      category === undefined
        ? findSelectConfigOptionById({ configOptions: this.configOptions, id: configId })
        : findSelectConfigOption({
            configOptions: this.configOptions,
            category,
            id: configId,
          });
    if (responseOption?.currentValue != null) {
      return responseOption.currentValue;
    }
    this.logger.warn(
      { configId, value: requestedValue },
      `ACP setSessionConfigOption response did not include the requested ${label} option currentValue; using requested value`,
    );
    return requestedValue;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values(), (entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request with id '${requestId}'`);
    }

    this.pendingPermissions.delete(requestId);
    const selectedOption = selectPermissionOption(pending.options, response);
    pending.resolve(
      selectedOption
        ? {
            outcome: {
              outcome: "selected",
              optionId: selectedOption.optionId,
            },
          }
        : { outcome: { outcome: "cancelled" } },
    );

    this.pushEvent({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      turnId: pending.turnId ?? undefined,
    });

    if (response.behavior === "deny" && response.interrupt && this.connection && this.sessionId) {
      await this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.sessionId) {
      return null;
    }
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        ...this.config,
        title: this.currentTitle,
      },
    };
  }

  async interrupt(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }

    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();

    if (this.activeForegroundTurnId) {
      await this.connection.cancel({ sessionId: this.sessionId });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.settleCommandsReady();

    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();

    if (this.connection && this.sessionId) {
      try {
        if (this.activeForegroundTurnId) {
          await this.connection.cancel({ sessionId: this.sessionId });
        }
      } catch {}

      try {
        if (this.agentCapabilities?.sessionCapabilities?.close) {
          await this.connection.unstable_closeSession({ sessionId: this.sessionId });
        }
      } catch (error) {
        this.logger.debug({ err: error }, "ACP closeSession failed during shutdown");
      }
    }

    const terminalTerminations = Array.from(this.terminalEntries.values(), (terminal) =>
      this.terminateProcess(terminal.child, {
        gracefulTimeoutMs: 2_000,
        forceTimeoutMs: 2_000,
      }),
    );
    await Promise.all(terminalTerminations);
    this.terminalEntries.clear();

    if (this.child) {
      await this.terminateProcess(this.child, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 2_000 });
    }

    this.subscribers.clear();
    this.connection = null;
    this.child = null;
    this.activeForegroundTurnId = null;
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Match Zed acp.rs:3189-3220: generic ACP permission requests stay pure pass-through.
    const requestId = randomUUID();
    let toolSnapshot =
      this.toolCalls.get(params.toolCall.toolCallId) ??
      mergeToolSnapshot(params.toolCall.toolCallId, params.toolCall);
    if (this.toolSnapshotTransformer) {
      toolSnapshot = this.toolSnapshotTransformer(toolSnapshot);
    }
    const request = mapPermissionRequest(this.provider, requestId, params, toolSnapshot);

    const promise = new Promise<RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        request,
        options: params.options,
        resolve,
        reject,
        turnId: this.activeForegroundTurnId,
      });
    });

    this.pushEvent({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: this.activeForegroundTurnId ?? undefined,
    });
    return promise;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: this.provider,
        sessionId: params.sessionId,
        rawEvent: params,
      },
      "provider.acp.raw_event",
    );
    if (params.sessionId !== this.sessionId) {
      return;
    }

    const events = this.translateSessionUpdate(params.update);
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: this.provider,
        sessionId: this.sessionId,
        turnId: this.activeForegroundTurnId ?? undefined,
        rawEvent: params,
        events,
      },
      "provider.acp.parsed_event",
    );
    if (this.replayingHistory) {
      for (const event of events) {
        if (event.type === "timeline") {
          this.persistedHistory.push(event.item);
        }
      }
      return;
    }

    for (const event of events) {
      this.pushEvent(event);
    }
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: this.provider,
        sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
        method,
        rawEvent: params,
      },
      "provider.acp.extension_notification",
    );

    const parsedCommands = this.extensionCommandsParser?.(method, params);
    if (parsedCommands) {
      this.applyResolvedCommands(parsedCommands, {
        sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      });
    }
  }

  // Cache an asynchronously-delivered slash-command batch and unblock any
  // listCommands() call that is waiting on the initial batch. Used when a
  // provider supplies an extensionCommandsParser whose result arrives after
  // session/new (e.g. via a vendor extension notification). The ready gate is
  // always settled — even for an empty batch — so a provider that legitimately
  // reports no commands does not leave listCommands() blocked for the full
  // initial-commands timeout. An optional sessionId scopes the batch to this
  // session; notifications addressed to a different session are ignored.
  private applyResolvedCommands(
    commands: AgentSlashCommand[],
    options?: { sessionId?: string },
  ): void {
    if (
      options?.sessionId !== undefined &&
      this.sessionId !== null &&
      options.sessionId !== this.sessionId
    ) {
      return;
    }

    if (commands.length > 0) {
      this.cachedCommands = commands;
    }
    this.settleCommandsReady();
  }

  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    const raw = await fs.readFile(params.path, "utf8");
    if (!params.line && !params.limit) {
      return { content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const start = Math.max((params.line ?? 1) - 1, 0);
    const end = params.limit ? start + params.limit : undefined;
    return { content: lines.slice(start, end).join("\n") };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, "utf8");
    return {};
  }

  async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const terminalId = randomUUID();
    const env = Object.fromEntries(
      (params.env ?? []).map((entry: EnvVariable) => [entry.name, entry.value]),
    );
    const terminalCommand = resolveTerminalCommand(params.command, params.args);
    const commandEnvOverlays =
      terminalCommand.shell === false ? [env, createStringCommandShellEnvOverlay()] : [env];
    const child = spawnProcess(terminalCommand.command, terminalCommand.args, {
      cwd: params.cwd ?? this.config.cwd,
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: commandEnvOverlays,
      }),
      shell: terminalCommand.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveExit!: (exit: TerminalExit) => void;
    let rejectExit!: (error: Error) => void;
    const waitForExit = new Promise<TerminalExit>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    waitForExit.catch(() => undefined);

    const entry: TerminalEntry = {
      id: terminalId,
      child,
      output: "",
      truncated: false,
      outputByteLimit: params.outputByteLimit ?? null,
      exit: null,
      waitForExit,
      resolveExit,
      rejectExit,
    };

    child.stdout!.on("data", (chunk: Buffer | string) =>
      appendTerminalOutput(entry, chunk.toString()),
    );
    child.stderr!.on("data", (chunk: Buffer | string) =>
      appendTerminalOutput(entry, chunk.toString()),
    );
    child.once("error", (error) => {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      appendTerminalOutput(entry, `${spawnError.message}\n`);
      rejectExit(spawnError);
    });
    child.once("exit", (code, signal) => {
      const exit = { exitCode: code, signal };
      entry.exit = exit;
      resolveExit(exit);
    });

    this.terminalEntries.set(terminalId, entry);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const entry = this.getTerminalEntry(params.terminalId);
    return {
      output: entry.output,
      truncated: entry.truncated,
      exitStatus: entry.exit ?? undefined,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<TerminalExit> {
    const entry = this.getTerminalEntry(params.terminalId);
    return entry.waitForExit;
  }

  async releaseTerminal(params: { sessionId: string; terminalId: string }): Promise<void> {
    const entry = this.getTerminalEntry(params.terminalId);
    if (!entry.exit) {
      await this.terminateProcess(entry.child, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 2_000 });
    }
    this.terminalEntries.delete(params.terminalId);
  }

  async killTerminal(params: KillTerminalRequest): Promise<Record<string, never>> {
    const entry = this.getTerminalEntry(params.terminalId);
    if (!entry.exit) {
      await this.terminateProcess(entry.child, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 2_000 });
    }
    return {};
  }

  private async spawnProcess(): Promise<SpawnedACPProcess> {
    const prefix = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: this.defaultCommand[0],
    });
    const availability = await checkProviderLaunchAvailable(prefix);
    if (!availability.available) {
      throw new Error(`${this.provider} command '${this.defaultCommand[0]}' not found`);
    }

    const command = prefix.command;
    const args = [...prefix.args, ...this.defaultCommand.slice(1)];
    const child = spawnProcess(command, args, {
      cwd: this.config.cwd,
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: [this.launchEnv],
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    assertChildWithPipes(child);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });
    child.once("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      if (this.activeForegroundTurnId) {
        this.synthesizeCanceledToolCalls();
        this.finishTurn({
          type: "turn_failed",
          provider: this.provider,
          error: `ACP agent exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""})`,
          diagnostic: stderrChunks.join("").trim() || undefined,
          turnId: this.activeForegroundTurnId,
        });
      }
    });

    const stream = createLoggedNdJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
      { logger: this.logger, provider: this.provider },
    );
    const connection = new ClientSideConnection(() => this, stream);
    const initialize = await this.runACPRequest(() =>
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: buildACPClientCapabilities(
          this.clientCapabilityMeta,
          this.clientCapabilities,
        ),
        clientInfo: { name: "Paseo", version: "dev" },
      }),
    );

    return { child, connection, initialize };
  }

  private async runACPRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw toACPRequestError(error);
    }
  }

  private acpMcpServers(): McpServer[] {
    return this.capabilities.supportsMcpServers ? normalizeMcpServers(this.config.mcpServers) : [];
  }

  private applySessionState(response: SessionStateResponse): void {
    const transformed = this.sessionResponseTransformer
      ? this.sessionResponseTransformer(response)
      : response;

    this.configOptions = this.transformConfigOptions(transformed.configOptions ?? []);

    const modeInfo = deriveModesFromACP(this.defaultModes, transformed.modes, this.configOptions);
    this.availableModes = modeInfo.modes;
    this.currentMode = modeInfo.currentModeId ?? this.currentMode;

    this.availableModels = transformed.models?.availableModels ?? null;
    this.currentModel =
      transformed.models?.currentModelId ?? deriveCurrentConfigValue(this.configOptions, "model");
    this.thinkingOptionId =
      deriveCurrentConfigValue(this.configOptions, "thought_level") ?? this.thinkingOptionId;
  }

  private transformConfigOptions(configOptions: SessionConfigOption[]): SessionConfigOption[] {
    return this.configOptionsTransformer
      ? this.configOptionsTransformer(configOptions)
      : configOptions;
  }

  private transformModeId(modeId: string): string | null {
    return this.modeIdTransformer ? this.modeIdTransformer(modeId) : modeId;
  }

  private async applyConfiguredOverrides(): Promise<void> {
    const configuredModeId = this.config.modeId;
    if (configuredModeId && configuredModeId !== this.currentMode) {
      const selection = resolveACPModeSelection({
        modeId: configuredModeId,
        availableModes: this.availableModes,
        configOptions: this.configOptions,
      });
      await this.setModeWithSelection({ modeId: configuredModeId, selection });
    }
    const configuredModelId = this.config.model;
    if (configuredModelId && configuredModelId !== this.currentModel) {
      const selection = resolveACPModelSelection({
        modelId: configuredModelId,
        availableModels: this.availableModels,
        configOptions: this.configOptions,
      });
      try {
        await this.setModelWithSelection({ modelId: configuredModelId, selection });
      } catch (error) {
        if (!this.isModelSelectionUnavailableError(error)) {
          throw error;
        }
        this.logger.warn(
          { value: configuredModelId },
          `${this.provider} does not expose ACP model selection; using provider default model`,
        );
      }
    }
    if (this.config.thinkingOptionId && this.config.thinkingOptionId !== this.thinkingOptionId) {
      await this.setThinkingOption(this.config.thinkingOptionId);
    }
    const configuredFeatureValues = this.config.featureValues ?? {};
    for (const featureOption of this.configFeatureOptions) {
      if (!Object.prototype.hasOwnProperty.call(configuredFeatureValues, featureOption.id)) {
        continue;
      }
      await this.setFeature(featureOption.id, configuredFeatureValues[featureOption.id]);
    }
  }

  private warnInvalidSelection(value: string, message: string): void {
    this.logger.warn({ value }, message);
  }

  private modelSelectionUnavailableMessage(): string {
    return `${this.provider} does not expose ACP model selection`;
  }

  private isModelSelectionUnavailableError(error: unknown): boolean {
    return error instanceof Error && error.message === this.modelSelectionUnavailableMessage();
  }

  private translateSessionUpdate(update: SessionUpdate): AgentStreamEvent[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        this.fallbackAssistantMessageId = null;
        const item = this.createMessageTimelineItem("user_message", update);
        if (!item) {
          return [];
        }
        if (item.type !== "user_message") {
          return [this.wrapTimeline(item)];
        }
        if (this.isSubmittedUserMessageEcho(item)) {
          return [];
        }
        return [this.wrapTimeline(item)];
      }
      case "agent_message_chunk": {
        const item = this.createMessageTimelineItem("assistant_message", update);
        return item ? [this.wrapTimeline(item)] : [];
      }
      case "agent_thought_chunk": {
        this.fallbackAssistantMessageId = null;
        const item = this.createMessageTimelineItem("reasoning", update);
        return item ? [this.wrapTimeline(item)] : [];
      }
      case "tool_call":
        this.fallbackAssistantMessageId = null;
        return this.handleToolCallUpdate(update.toolCallId, update, undefined);
      case "tool_call_update":
        return this.handleToolCallUpdate(
          update.toolCallId,
          update,
          this.toolCalls.get(update.toolCallId),
        );
      case "plan":
        this.fallbackAssistantMessageId = null;
        return [this.wrapTimeline(mapPlanToTimeline(update))];
      case "current_mode_update":
        this.handleCurrentModeUpdate(update);
        return [
          {
            type: "mode_changed",
            provider: this.provider,
            currentModeId: this.currentMode,
            availableModes: [...this.availableModes],
          },
        ];
      case "config_option_update":
        return this.handleConfigOptionUpdate(update);
      case "session_info_update":
        this.handleSessionInfoUpdate(update);
        return [];
      case "usage_update":
        this.handleUsageUpdate(update);
        return [];
      case "available_commands_update":
        this.cachedCommands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: "",
          kind: "command",
        }));
        this.settleCommandsReady();
        return [];
      default:
        return [];
    }
  }

  private handleToolCallUpdate(
    toolCallId: string,
    update: ToolCall | ToolCallUpdate,
    previous: ACPToolSnapshot | undefined,
  ): AgentStreamEvent[] {
    let snapshot = mergeToolSnapshot(toolCallId, update, previous);
    if (this.toolSnapshotTransformer) {
      snapshot = this.toolSnapshotTransformer(snapshot);
    }
    this.toolCalls.set(toolCallId, snapshot);
    return [this.wrapTimeline(mapToolSnapshotToTimeline(snapshot, this.terminalEntries))];
  }

  private createMessageTimelineItem(
    type: "user_message" | "assistant_message" | "reasoning",
    update: Extract<
      SessionUpdate,
      { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
    >,
  ):
    | { type: "user_message"; text: string; messageId?: string }
    | { type: "assistant_message"; text: string; messageId: string }
    | { type: "reasoning"; text: string }
    | null {
    const chunkText = contentBlockToText(update.content);
    if (!chunkText) {
      return null;
    }
    const key = this.messageAssemblyKey(type, update.messageId);
    const state = this.messageAssemblies.get(key) ?? { text: "" };
    state.text += chunkText;
    this.messageAssemblies.set(key, state);

    if (type === "user_message") {
      return { type: "user_message", text: state.text, messageId: update.messageId ?? undefined };
    }
    if (type === "assistant_message") {
      return {
        type: "assistant_message",
        text: chunkText,
        messageId: this.resolveAssistantMessageId(update.messageId),
      };
    }
    return { type: "reasoning", text: chunkText };
  }

  private resolveAssistantMessageId(messageId: string | null | undefined): string {
    if (messageId) {
      this.fallbackAssistantMessageId = null;
      return messageId;
    }
    this.fallbackAssistantMessageId ??= randomUUID();
    return this.fallbackAssistantMessageId;
  }

  private messageAssemblyKey(
    type: "user_message" | "assistant_message" | "reasoning",
    messageId: string | null | undefined,
  ): string {
    const fallbackId =
      type === "user_message" ? (this.activeForegroundTurnId ?? "default") : "default";
    return `${type}:${messageId ?? fallbackId}`;
  }

  private handleCurrentModeUpdate(update: CurrentModeUpdate): void {
    this.currentMode = this.transformModeId(update.currentModeId);
  }

  private handleConfigOptionUpdate(update: ConfigOptionUpdate): AgentStreamEvent[] {
    this.configOptions = this.transformConfigOptions(update.configOptions);
    const modeInfo = deriveModesFromACP(this.defaultModes, null, this.configOptions);
    const nextMode = modeInfo.currentModeId;
    const nextModel = deriveCurrentConfigValue(this.configOptions, "model");
    const nextThinkingOptionId = deriveCurrentConfigValue(this.configOptions, "thought_level");

    this.availableModes = modeInfo.modes;
    this.currentMode = nextMode ?? this.currentMode;
    this.currentModel = nextModel ?? this.currentModel;
    this.thinkingOptionId = nextThinkingOptionId ?? this.thinkingOptionId;

    const events: AgentStreamEvent[] = [];
    if (nextMode !== null) {
      events.push({
        type: "mode_changed",
        provider: this.provider,
        currentModeId: this.currentMode,
        availableModes: [...this.availableModes],
      });
    }
    if (nextModel !== null) {
      events.push({
        type: "model_changed",
        provider: this.provider,
        runtimeInfo: this.runtimeInfo(),
      });
    }
    if (nextThinkingOptionId !== null) {
      events.push({
        type: "thinking_option_changed",
        provider: this.provider,
        thinkingOptionId: this.thinkingOptionId,
      });
    }
    return events;
  }

  private handleSessionInfoUpdate(update: SessionInfoUpdate): void {
    if ("title" in update) {
      this.currentTitle = update.title ?? null;
    }
    if ("updatedAt" in update) {
      this.lastActivityAt = update.updatedAt ?? null;
    }
  }

  private handleUsageUpdate(update: UsageUpdate): void {
    void update;
  }

  private handlePromptResponse(response: PromptResponse, turnId: string): void {
    this.currentTurnUsage = mapACPUsage(response.usage) ?? this.currentTurnUsage;

    switch (response.stopReason) {
      case "cancelled":
        this.synthesizeCanceledToolCalls();
        this.finishTurn({
          type: "turn_canceled",
          provider: this.provider,
          reason: "Interrupted",
          turnId,
        });
        break;
      case "end_turn":
      case "max_tokens":
      case "max_turn_requests":
      case "refusal":
      default:
        this.finishTurn({
          type: "turn_completed",
          provider: this.provider,
          usage: this.currentTurnUsage,
          turnId,
        });
        break;
    }
  }

  private wrapTimeline(item: AgentTimelineItem): AgentStreamEvent {
    return {
      type: "timeline",
      provider: this.provider,
      item,
      turnId: this.activeForegroundTurnId ?? undefined,
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: this.provider,
        sessionId: this.sessionId,
        turnId: getAgentStreamEventTurnId(event) ?? this.activeForegroundTurnId ?? undefined,
        event,
      },
      "provider.acp.event_emit",
    );
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private emitSubmittedUserMessage(
    prompt: AgentPromptInput,
    messageId: string,
    turnId: string,
  ): void {
    const text = extractPromptText(prompt);
    if (text.trim().length === 0) {
      return;
    }
    this.submittedUserMessageIds.add(messageId);
    this.activeSubmittedUserMessage = { messageId, text, turnId };
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "user_message", text, messageId },
    });
  }

  private runtimeInfo(): AgentRuntimeInfo {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.currentModel,
      thinkingOptionId: this.thinkingOptionId,
      modeId: this.currentMode,
      extra: {
        title: this.currentTitle,
        updatedAt: this.lastActivityAt,
      },
    };
  }

  private finishTurn(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  ): void {
    this.activeForegroundTurnId = null;
    this.fallbackAssistantMessageId = null;
    if (this.activeSubmittedUserMessage?.turnId === event.turnId) {
      this.activeSubmittedUserMessage = null;
    }
    this.pushEvent(event);
  }

  private isSubmittedUserMessageEcho(
    item: Extract<AgentTimelineItem, { type: "user_message" }>,
  ): boolean {
    const active = this.activeSubmittedUserMessage;
    if (!active || active.turnId !== this.activeForegroundTurnId) {
      return false;
    }
    if (item.messageId) {
      if (this.submittedUserMessageIds.has(item.messageId)) {
        return true;
      }
    }
    return active.text.startsWith(item.text);
  }

  private emitBootstrapThreadEvent(): void {
    if (!this.bootstrapThreadEventPending || !this.sessionId) {
      return;
    }
    this.bootstrapThreadEventPending = false;
    this.pushEvent({
      type: "thread_started",
      provider: this.provider,
      sessionId: this.sessionId,
    });
  }

  private synthesizeCanceledToolCalls(): void {
    for (const snapshot of this.toolCalls.values()) {
      const mapped = mapToolSnapshotToTimeline(snapshot, this.terminalEntries);
      if (mapped.status === "running") {
        this.pushEvent(
          this.wrapTimeline({
            ...mapped,
            status: "canceled",
            error: null,
          }),
        );
      }
    }
  }

  private collectDiagnostic(message: string): string | undefined {
    const parts: string[] = [message];
    if (this.child?.exitCode != null) {
      parts.push(`exitCode=${this.child.exitCode}`);
    }
    if (this.child?.signalCode) {
      parts.push(`signal=${this.child.signalCode}`);
    }
    return parts.length > 0 ? parts.join(" | ") : undefined;
  }

  private getTerminalEntry(terminalId: string): TerminalEntry {
    const entry = this.terminalEntries.get(terminalId);
    if (!entry) {
      throw new Error(`Unknown terminal '${terminalId}'`);
    }
    return entry;
  }
}

function findSelectConfigOption({
  configOptions,
  category,
  id,
}: {
  configOptions: SessionConfigOption[] | null | undefined;
  category: string;
  id?: string;
}): SelectConfigOption | null {
  const option = configOptions?.find(
    (entry): entry is SelectConfigOption =>
      entry.type === "select" && entry.category === category && (!id || entry.id === id),
  );
  return option ?? null;
}

function findSelectConfigOptionById({
  configOptions,
  id,
}: {
  configOptions: SessionConfigOption[] | null | undefined;
  id: string;
}): SelectConfigOption | null {
  const option = configOptions?.find(
    (entry): entry is SelectConfigOption => entry.type === "select" && entry.id === id,
  );
  return option ?? null;
}

function findSelectConfigFeatureOption(
  configOptions: SessionConfigOption[] | null | undefined,
  featureOption: ACPConfigFeatureOption,
): SelectConfigOption | null {
  const option = configOptions?.find(
    (entry): entry is SelectConfigOption =>
      entry.type === "select" &&
      entry.id === featureOption.configId &&
      (featureOption.category === undefined || entry.category === featureOption.category),
  );
  return option ?? null;
}

function findSelectConfigChoice({
  option,
  value,
}: {
  option: SelectConfigOption | null;
  value: string;
}): SelectConfigChoice | null {
  if (!option) {
    return null;
  }
  return flattenSelectOptions(option.options).find((choice) => choice.value === value) ?? null;
}

function flattenSelectOptions(options: SelectConfigOption["options"]): SelectConfigChoice[] {
  const flattened: SelectConfigChoice[] = [];
  for (const option of options) {
    if ("value" in option) {
      flattened.push(option);
      continue;
    }
    for (const groupOption of option.options) {
      flattened.push({ ...groupOption, group: option.group });
    }
  }
  return flattened;
}

function deriveConfigFeatureSelectOptions(
  option: SelectConfigOption,
  featureOption: ACPConfigFeatureOption,
): ConfigOptionSelector[] {
  return flattenSelectOptions(option.options).map((choice) => ({
    id: choice.value,
    label: normalizeConfigFeatureOptionLabel(choice, featureOption),
    description: choice.description ?? undefined,
    isDefault: choice.value === option.currentValue,
    metadata: choice.group ? { group: choice.group } : undefined,
  }));
}

function normalizeConfigFeatureOptionLabel(
  choice: SelectConfigChoice,
  featureOption: ACPConfigFeatureOption,
): string {
  const name = choice.name.trim();
  if (name) {
    return name;
  }
  if (choice.value === "" && featureOption.emptyOptionLabel) {
    return featureOption.emptyOptionLabel;
  }
  return choice.value;
}

function normalizeConfigFeatureValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "";
  }
  throw new Error(`ACP feature value must be a string`);
}

function deriveSelectorOptions(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): ConfigOptionSelector[] {
  const option = findSelectConfigOption({ configOptions, category });
  if (!option) {
    return [];
  }

  return flattenSelectOptions(option.options).map((value) => ({
    id: value.value,
    label: value.name,
    description: value.description ?? undefined,
    isDefault: value.value === option.currentValue,
    metadata: value.group ? { group: value.group } : undefined,
  }));
}

function deriveCurrentConfigValue(
  configOptions: SessionConfigOption[] | null | undefined,
  category: string,
): string | null {
  const option = configOptions?.find(
    (entry): entry is Extract<SessionConfigOption, { type: "select" }> =>
      entry.type === "select" && entry.category === category,
  );
  return option?.currentValue ?? null;
}

function normalizeMcpServers(servers?: Record<string, McpServerConfig>): McpServer[] {
  if (!servers) {
    return [];
  }

  return Object.entries(servers).map(([name, config]) => {
    if (config.type === "stdio") {
      return {
        name,
        command: config.command,
        args: config.args ?? [],
        env: Object.entries(config.env ?? {}).map(([envName, value]) => ({
          name: envName,
          value,
        })),
      } satisfies McpServer;
    }

    if (config.type === "http") {
      return {
        type: "http",
        name,
        url: config.url,
        headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
          name: headerName,
          value,
        })),
      } satisfies McpServer;
    }

    return {
      type: "sse",
      name,
      url: config.url,
      headers: Object.entries(config.headers ?? {}).map(([headerName, value]) => ({
        name: headerName,
        value,
      })),
    } satisfies McpServer;
  });
}

function toACPContentBlocks(prompt: AgentPromptInput): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }

  const contentBlocks: ContentBlock[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        contentBlocks.push({ type: "text", text: block.text });
        break;
      case "image":
        contentBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      default:
        contentBlocks.push({ type: "text", text: renderPromptAttachmentAsText(block) });
        break;
    }
  }
  return contentBlocks;
}

function extractPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .filter(
      (block): block is Extract<AgentPromptContentBlock, { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function contentBlockToText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.uri;
    case "resource":
      return "text" in content.resource
        ? content.resource.text
        : `[resource:${content.resource.mimeType ?? "binary"}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

function coalesceDefined<T>(next: T | undefined, previous: T | undefined, fallback: T): T {
  if (next !== undefined) {
    return next;
  }
  if (previous !== undefined) {
    return previous;
  }
  return fallback;
}

function mergeToolSnapshot(
  toolCallId: string,
  update: ToolCall | ToolCallUpdate,
  previous?: ACPToolSnapshot,
): ACPToolSnapshot {
  return {
    toolCallId,
    title: update.title ?? previous?.title ?? toolCallId,
    kind: update.kind ?? previous?.kind ?? null,
    status: update.status ?? previous?.status ?? null,
    content: coalesceDefined(update.content, previous?.content, null),
    locations: coalesceDefined(update.locations, previous?.locations, null),
    rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
  };
}

function mapPlanToTimeline(plan: Plan): AgentTimelineItem {
  return {
    type: "todo",
    items: plan.entries.map((entry) => ({
      text: entry.content,
      completed: entry.status === "completed",
    })),
  };
}

function mapToolSnapshotToTimeline(
  snapshot: ACPToolSnapshot,
  terminals: Map<string, TerminalEntry>,
): ToolCallTimelineItem {
  const status = mapToolStatus(snapshot.status);
  const detail = mapToolDetail(snapshot, terminals);
  const base = {
    type: "tool_call" as const,
    callId: snapshot.toolCallId,
    name: snapshot.kind ?? snapshot.title,
    detail,
    metadata: {
      kind: snapshot.kind ?? undefined,
      title: snapshot.title,
    },
  };
  if (status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { message: readErrorMessage(snapshot.rawOutput) },
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status: "completed",
      error: null,
    };
  }
  return {
    ...base,
    status: "running",
    error: null,
  };
}

function mapToolStatus(status: ToolCallStatus | null | undefined): ToolCallTimelineItem["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    default:
      return "running";
  }
}

interface MapToolDetailContext {
  snapshot: ACPToolSnapshot;
  firstLocation: string | undefined;
  textContent: string | undefined;
  diffContent: ReturnType<typeof extractDiffContent>;
  terminalContent: ReturnType<typeof extractTerminalContent>;
  rawInput: ReturnType<typeof readRecord>;
  rawOutput: ReturnType<typeof readRecord>;
}

function mapToolDetail(
  snapshot: ACPToolSnapshot,
  terminals: Map<string, TerminalEntry>,
): ToolCallDetail {
  const context: MapToolDetailContext = {
    snapshot,
    firstLocation: snapshot.locations?.[0]?.path,
    textContent: extractToolText(snapshot.content),
    diffContent: extractDiffContent(snapshot.content),
    terminalContent: extractTerminalContent(snapshot.content, terminals),
    rawInput: readRecord(snapshot.rawInput),
    rawOutput: readRecord(snapshot.rawOutput),
  };

  switch (snapshot.kind) {
    case "read":
      return buildReadToolDetail(context);
    case "edit":
    case "delete":
      return buildEditToolDetail(context);
    case "search":
      return buildSearchAcpToolDetail(context);
    case "execute":
      return buildShellToolDetail(context);
    case "fetch":
      return buildFetchToolDetail(context);
    case "think":
      return {
        type: "plain_text",
        label: snapshot.title,
        icon: "brain",
        text: context.textContent ?? stringifyUnknown(snapshot.rawOutput),
      };
    case "switch_mode":
      return {
        type: "plain_text",
        label: snapshot.title,
        icon: "sparkles",
        text: context.textContent ?? stringifyUnknown(snapshot.rawInput),
      };
    default:
      return buildDefaultToolDetail(context);
  }
}

function buildReadToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, firstLocation, textContent, rawInput, rawOutput } = context;
  return {
    type: "read",
    filePath: firstLocation ?? readString(rawInput, ["path", "filePath", "file"]) ?? snapshot.title,
    content: textContent ?? readString(rawOutput, ["content", "text"]),
    offset: readNumber(rawInput, ["offset", "line"]),
    limit: readNumber(rawInput, ["limit"]),
  };
}

function buildEditToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, firstLocation, textContent, diffContent, rawInput } = context;
  return {
    type: "edit",
    filePath: firstLocation ?? readString(rawInput, ["path", "filePath", "file"]) ?? snapshot.title,
    oldString: diffContent?.oldText ?? readString(rawInput, ["oldText", "oldString"]),
    newString:
      snapshot.kind === "delete"
        ? ""
        : (diffContent?.newText ?? readString(rawInput, ["newText", "newString"])),
    unifiedDiff: textContent ?? undefined,
  };
}

function buildSearchAcpToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, textContent, rawInput, rawOutput } = context;
  return {
    type: "search",
    query: readString(rawInput, ["query", "pattern"]) ?? snapshot.title,
    toolName: "search",
    content: textContent ?? readString(rawOutput, ["content", "text"]),
    filePaths: snapshot.locations?.map((location) => location.path),
  };
}

function buildShellToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, textContent, terminalContent, rawInput, rawOutput } = context;
  return {
    type: "shell",
    command:
      terminalContent?.command ??
      buildShellCommand(rawInput) ??
      readString(rawInput, ["command"]) ??
      snapshot.title,
    cwd: terminalContent?.cwd ?? readString(rawInput, ["cwd"]),
    output: terminalContent?.output ?? textContent ?? readString(rawOutput, ["output", "text"]),
    exitCode: terminalContent?.exitCode ?? readNumber(rawOutput, ["exitCode"]),
  };
}

function buildFetchToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, textContent, rawInput, rawOutput } = context;
  return {
    type: "fetch",
    url: readString(rawInput, ["url"]) ?? snapshot.title,
    prompt: readString(rawInput, ["prompt"]),
    result: textContent ?? readString(rawOutput, ["result", "text", "content"]),
    code: readNumber(rawOutput, ["status", "code"]),
  };
}

function buildDefaultToolDetail(context: MapToolDetailContext): ToolCallDetail {
  const { snapshot, textContent, terminalContent } = context;
  if (terminalContent) {
    return {
      type: "shell",
      command: terminalContent.command ?? snapshot.title,
      cwd: terminalContent.cwd,
      output: terminalContent.output,
      exitCode: terminalContent.exitCode,
    };
  }
  if (textContent) {
    return {
      type: "plain_text",
      label: snapshot.title,
      text: textContent,
      icon: "wrench",
    };
  }
  return {
    type: "unknown",
    input: snapshot.rawInput ?? null,
    output: snapshot.rawOutput ?? null,
  };
}

function extractToolText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const text = contentBlockToText(item.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractDiffContent(
  content: ToolCallContent[] | null | undefined,
): { oldText?: string | null; newText: string } | null {
  const diff = content?.find(
    (item): item is Extract<ToolCallContent, { type: "diff" }> => item.type === "diff",
  );
  return diff ? { oldText: diff.oldText ?? undefined, newText: diff.newText } : null;
}

function extractTerminalContent(
  content: ToolCallContent[] | null | undefined,
  terminals: Map<string, TerminalEntry>,
):
  | {
      command?: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | undefined {
  const terminal = content?.find(
    (item): item is Extract<ToolCallContent, { type: "terminal" }> => item.type === "terminal",
  );
  if (!terminal) {
    return undefined;
  }
  const entry = terminals.get(terminal.terminalId);
  if (!entry) {
    return undefined;
  }
  return {
    output: entry.output,
    exitCode: entry.exit?.exitCode ?? null,
  };
}

function mapPermissionRequest(
  provider: string,
  requestId: string,
  params: RequestPermissionRequest,
  snapshot: ACPToolSnapshot,
): AgentPermissionRequest {
  const kind: AgentPermissionRequestKind = snapshot.kind === "switch_mode" ? "mode" : "tool";
  return {
    id: requestId,
    provider,
    name: snapshot.kind ?? snapshot.title,
    kind,
    title: params.toolCall.title ?? snapshot.title,
    detail: mapToolDetail(snapshot, new Map()),
    metadata: {
      toolCallId: params.toolCall.toolCallId,
      rawRequest: params,
      options: params.options,
    },
  };
}

function selectPermissionOption(
  options: PermissionOption[],
  response: AgentPermissionResponse,
): PermissionOption | null {
  const order =
    response.behavior === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of order) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return null;
}

function appendTerminalOutput(entry: TerminalEntry, chunk: string): void {
  entry.output += chunk;
  const limit = entry.outputByteLimit;
  if (!limit) {
    return;
  }
  while (Buffer.byteLength(entry.output, "utf8") > limit && entry.output.length > 0) {
    entry.output = entry.output.slice(1);
    entry.truncated = true;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildShellCommand(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined;
  }
  const command = readString(record, ["command"]);
  const args = Array.isArray(record["args"])
    ? record["args"].filter((value): value is string => typeof value === "string")
    : [];
  if (!command) {
    return undefined;
  }
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  return readString(record, ["message", "error"]) ?? "Tool call failed";
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "bigint" ? String(value) : "[unserializable]";
  }
}

function coerceSessionConfigMetadata(
  metadata: AgentMetadata | undefined,
): Partial<AgentSessionConfig> {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  return metadata as Partial<AgentSessionConfig>;
}

async function terminateChildProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  terminate: ProcessTerminator,
): Promise<void> {
  try {
    await terminate(child, { gracefulTimeoutMs: timeoutMs, forceTimeoutMs: timeoutMs });
  } finally {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
