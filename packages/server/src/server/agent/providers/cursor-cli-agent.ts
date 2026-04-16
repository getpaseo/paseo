import { execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
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
  ListModesOptions,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  applyProviderEnv,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { spawnProcess } from "../../../utils/spawn.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const execFileAsync = promisify(execFile);

const CURSOR_PROVIDER = "cursor" as const;

const CURSOR_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

const CURSOR_MODES: AgentMode[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Full tool access (headless `agent -p` with --force).",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning (`--mode plan`).",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Q&A without edits (`--mode ask`).",
  },
];

// #region helpers

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

function unwrapCursorHistoryText(text: string): string {
  const withoutRedacted = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "[REDACTED]")
    .join("\n\n");
  const trimmed = withoutRedacted.trim();
  const userQuery = /^<user_query>\s*\n?([\s\S]*?)\n?<\/user_query>$/u.exec(trimmed);
  if (userQuery?.[1]) {
    return userQuery[1].trim();
  }
  return trimmed;
}

function extractCursorHistoryText(message: unknown): string {
  return unwrapCursorHistoryText(extractAssistantText(message));
}

function isSafeCursorSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9-]+$/u.test(sessionId);
}

function resolveCursorTranscriptPath(cwd: string, sessionId: string): string | null {
  if (!isSafeCursorSessionId(sessionId)) {
    return null;
  }
  const projectDir = cwd.replace(/[\\/:\.]+/g, "-").replace(/^-+|-+$/g, "");
  return path.join(
    os.homedir(),
    ".cursor",
    "projects",
    projectDir,
    "agent-transcripts",
    sessionId,
    `${sessionId}.jsonl`,
  );
}

function parseCursorTranscriptLine(line: string): AgentTimelineItem[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  let entry: { role?: unknown; message?: unknown };
  try {
    entry = JSON.parse(trimmed) as { role?: unknown; message?: unknown };
  } catch {
    return [];
  }

  if (entry.role === "user") {
    const text = extractCursorHistoryText(entry.message);
    return text ? [{ type: "user_message", text }] : [];
  }
  if (entry.role === "assistant") {
    const text = extractCursorHistoryText(entry.message);
    return text ? [{ type: "assistant_message", text }] : [];
  }
  return [];
}

function loadCursorTranscriptHistory(cwd: string, sessionId: string): AgentTimelineItem[] {
  const transcriptPath = resolveCursorTranscriptPath(cwd, sessionId);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const timeline: AgentTimelineItem[] = [];
    for (const line of content.split(/\r?\n/)) {
      timeline.push(...parseCursorTranscriptLine(line));
    }
    return timeline;
  } catch {
    return [];
  }
}

function mapStreamJsonUsage(raw: unknown): AgentUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const input = typeof u.inputTokens === "number" ? u.inputTokens : undefined;
  const output = typeof u.outputTokens === "number" ? u.outputTokens : undefined;
  const cacheRead = typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : undefined;
  if (input === undefined && output === undefined && cacheRead === undefined) {
    return undefined;
  }
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
    ...(typeof cacheRead === "number" ? { cachedInputTokens: cacheRead } : {}),
  };
}

function parseListModelsFromStdout(stdout: string): AgentModelDefinition[] {
  const text = stripAnsi(stdout);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith("available models"));
  const slice = start >= 0 ? lines.slice(start + 1) : lines;
  const models: AgentModelDefinition[] = [];
  for (const line of slice) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Loading")) {
      continue;
    }
    const m = /^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+)$/i.exec(trimmed);
    if (!m) {
      continue;
    }
    const id = m[1]!;
    const label = m[2]!.replace(/\s*\(default\)\s*$/i, "").trim();
    const isDefault = /\bdefault\b/i.test(m[2]!);
    models.push({
      provider: CURSOR_PROVIDER,
      id,
      label,
      ...(isDefault ? { isDefault: true } : {}),
    });
  }
  return models;
}

function buildPrintArgv(
  config: AgentSessionConfig,
  promptText: string,
  resumeChatId: string | null,
): string[] {
  const argv = [
    "-p",
    "--force",
    "--trust",
    "--output-format",
    "stream-json",
    "--workspace",
    config.cwd,
  ];
  if (config.model && config.model.trim()) {
    argv.push("--model", config.model.trim());
  }
  const modeId = config.modeId?.trim();
  if (modeId === "plan") {
    argv.push("--mode", "plan");
  } else if (modeId === "ask") {
    argv.push("--mode", "ask");
  }
  if (resumeChatId) {
    argv.push("--resume", resumeChatId);
  }
  const body =
    typeof config.systemPrompt === "string" && config.systemPrompt.trim()
      ? `${config.systemPrompt.trim()}\n\n${promptText}`
      : promptText;
  argv.push(body);
  return argv;
}

function firstToolCallKey(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }
  const keys = Object.keys(toolCall as object);
  return keys[0] ?? null;
}

function mapToolCallToTimeline(
  callId: string,
  subtype: string,
  payload: unknown,
): ToolCallTimelineItem | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const toolCall = (payload as { tool_call?: unknown }).tool_call;
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }
  const key = firstToolCallKey(toolCall);
  if (key === "shellToolCall") {
    const shell = (toolCall as { shellToolCall?: Record<string, unknown> }).shellToolCall;
    const args = shell?.args as { command?: string } | undefined;
    const command = typeof args?.command === "string" ? args.command : "";
    if (subtype === "started") {
      return {
        type: "tool_call",
        callId,
        name: "Shell",
        detail: { type: "shell", command },
        status: "running",
        error: null,
      };
    }
    const shellResult = shell?.result as Record<string, unknown> | undefined;
    const rejected = shellResult?.rejected as { reason?: string } | undefined;
    const success = shellResult?.success as { output?: string; exitCode?: number } | undefined;
    if (rejected) {
      return {
        type: "tool_call",
        callId,
        name: "Shell",
        detail: {
          type: "shell",
          command,
          output: typeof rejected.reason === "string" ? rejected.reason : "",
          exitCode: 1,
        },
        status: "failed",
        error: rejected.reason ?? "rejected",
      };
    }
    if (success) {
      return {
        type: "tool_call",
        callId,
        name: "Shell",
        detail: {
          type: "shell",
          command,
          output: typeof success.output === "string" ? success.output : "",
          exitCode: typeof success.exitCode === "number" ? success.exitCode : 0,
        },
        status: "completed",
        error: null,
      };
    }
    return {
      type: "tool_call",
      callId,
      name: "Shell",
      detail: { type: "unknown", input: shell ?? null, output: null },
      status: "completed",
      error: null,
    };
  }

  if (subtype === "started") {
    return {
      type: "tool_call",
      callId,
      name: key ?? "Tool",
      detail: { type: "unknown", input: toolCall, output: null },
      status: "running",
      error: null,
    };
  }
  return {
    type: "tool_call",
    callId,
    name: key ?? "Tool",
    detail: { type: "unknown", input: null, output: toolCall },
    status: "completed",
    error: null,
  };
}

async function resolveAgentLaunchPrefix(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<{ command: string; args: string[] }> {
  const resolved = await findExecutable("agent");
  return resolveProviderCommandPrefix(runtimeSettings?.command, () => {
    if (!resolved) {
      throw new Error(
        "Cursor Agent CLI not found. Install it (https://cursor.com/docs/cli/installation) and ensure `agent` is on PATH.",
      );
    }
    return resolved;
  });
}

// #endregion

// #region CursorCliAgentClient

type CursorCliAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

export class CursorCliAgentClient implements AgentClient {
  readonly provider = CURSOR_PROVIDER;
  readonly capabilities = CURSOR_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;

  constructor(options: CursorCliAgentClientOptions) {
    this.logger = options.logger.child({ module: "agent", provider: CURSOR_PROVIDER });
    this.runtimeSettings = options.runtimeSettings;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.assertProvider(config);
    return new CursorCliAgentSession(
      { ...config, provider: CURSOR_PROVIDER },
      {
        logger: this.logger,
        runtimeSettings: this.runtimeSettings,
        resumeChatId: null,
        launchEnv: launchContext?.env,
      },
    );
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides: Partial<AgentSessionConfig> | undefined,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    if (handle.provider !== CURSOR_PROVIDER) {
      throw new Error(`Cannot resume ${handle.provider} with Cursor CLI client`);
    }
    const cwd = overrides?.cwd ?? (handle.metadata as { cwd?: string } | undefined)?.cwd;
    if (!cwd || typeof cwd !== "string") {
      throw new Error("Cursor resume requires cwd in overrides or persistence metadata");
    }
    const merged: AgentSessionConfig = {
      ...(handle.metadata as AgentSessionConfig),
      ...overrides,
      provider: CURSOR_PROVIDER,
      cwd,
    };
    return new CursorCliAgentSession(merged, {
      logger: this.logger,
      runtimeSettings: this.runtimeSettings,
      resumeChatId: handle.nativeHandle ?? handle.sessionId,
      launchEnv: launchContext?.env,
    });
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const cwd = options?.cwd ?? process.cwd();
    const { command, args } = await resolveAgentLaunchPrefix(this.runtimeSettings);
    const { stdout } = await execFileAsync(command, [...args, "--list-models"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20_000_000,
      env: applyProviderEnv(
        process.env as Record<string, string | undefined>,
        this.runtimeSettings,
      ),
    });
    return parseListModelsFromStdout(stdout);
  }

  async listModes(_options?: ListModesOptions): Promise<AgentMode[]> {
    return [...CURSOR_MODES];
  }

  async isAvailable(): Promise<boolean> {
    try {
      await resolveAgentLaunchPrefix(this.runtimeSettings);
      return true;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("agent");
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

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
      }

      return {
        diagnostic: formatProviderDiagnostic("Cursor", [
          {
            label: "Binary",
            value: resolvedBinary ?? "not found (https://cursor.com/docs/cli/installation)",
          },
          {
            label: "Version",
            value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
          },
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Cursor", error),
      };
    }
  }

  private assertProvider(config: AgentSessionConfig): void {
    if (config.provider !== CURSOR_PROVIDER) {
      throw new Error(`Expected provider ${CURSOR_PROVIDER}`);
    }
  }
}

// #endregion

// #region CursorCliAgentSession

type CursorCliAgentSessionOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  resumeChatId: string | null;
  launchEnv?: Record<string, string>;
};

export class CursorCliAgentSession implements AgentSession {
  readonly provider = CURSOR_PROVIDER;
  readonly capabilities = CURSOR_CAPABILITIES;
  readonly id: string | null = null;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly launchEnv?: Record<string, string>;
  private readonly resumeChatId: string | null;
  private config: AgentSessionConfig;
  private sessionId: string | null = null;
  private currentModel: string | null = null;
  private currentMode: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeForegroundTurnId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private bootstrapThreadEventPending = true;
  private persistedHistory: AgentTimelineItem[] = [];
  private historyPending = false;

  constructor(config: AgentSessionConfig, options: CursorCliAgentSessionOptions) {
    this.logger = options.logger.child({ module: "agent", provider: CURSOR_PROVIDER });
    this.runtimeSettings = options.runtimeSettings;
    this.launchEnv = options.launchEnv;
    this.resumeChatId = options.resumeChatId;
    this.config = config;
    this.currentModel = config.model ?? null;
    this.currentMode = config.modeId ?? "agent";
    if (this.resumeChatId) {
      this.persistedHistory = loadCursorTranscriptHistory(this.config.cwd, this.resumeChatId);
      this.historyPending = this.persistedHistory.length > 0;
    }
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
    const history = this.persistedHistory;
    this.persistedHistory = [];
    this.historyPending = false;
    for (const item of history) {
      yield { type: "timeline", provider: this.provider, item };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.currentModel,
      modeId: this.currentMode,
      extra: {
        title: this.config.title ?? undefined,
      },
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...CURSOR_MODES];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode;
  }

  async setMode(modeId: string): Promise<void> {
    this.config = { ...this.config, modeId };
    this.currentMode = modeId;
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config = { ...this.config, model: modelId ?? undefined };
    this.currentModel = modelId;
  }

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {
    throw new Error("Cursor CLI print mode does not support interactive permission responses");
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
        cwd: this.config.cwd,
      },
    };
  }

  async interrupt(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
    this.subscribers.clear();
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let turnId: string | null = null;
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const buffered: AgentStreamEvent[] = [];

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const processEvent = (event: AgentStreamEvent) => {
      if (settled) {
        return;
      }
      if (turnId && "turnId" in event && event.turnId && event.turnId !== turnId) {
        return;
      }
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text.startsWith(finalText)
            ? event.item.text
            : `${finalText}${event.item.text}`;
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

    const unsubscribe = this.subscribe((event) => {
      if (!turnId) {
        buffered.push(event);
        return;
      }
      processEvent(event);
    });

    try {
      const started = await this.startTurn(prompt, options);
      turnId = started.turnId;
      for (const event of buffered) {
        processEvent(event);
      }
      if (!settled) {
        await completion;
      }
    } finally {
      unsubscribe();
    }

    return {
      sessionId: this.sessionId ?? randomUUID(),
      finalText,
      usage,
      timeline,
    };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Cursor CLI session is closed");
    }
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    const turnId = randomUUID();
    this.activeForegroundTurnId = turnId;
    this.pushEvent({ type: "turn_started", provider: this.provider, turnId });

    const promptText = extractPromptText(prompt);
    void this.runAgentProcess(promptText, turnId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTurn({
        type: "turn_failed",
        provider: this.provider,
        error: message,
        turnId,
      });
    });

    return { turnId };
  }

  private async runAgentProcess(promptText: string, turnId: string): Promise<void> {
    const { command, args } = await resolveAgentLaunchPrefix(this.runtimeSettings);
    const resumeTarget = this.sessionId ?? this.resumeChatId;
    const argv = [...args, ...buildPrintArgv(this.config, promptText, resumeTarget)];

    const child = spawnProcess(command, argv, {
      cwd: this.config.cwd,
      env: {
        ...applyProviderEnv(
          process.env as Record<string, string | undefined>,
          this.runtimeSettings,
        ),
        ...(this.launchEnv ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.logger.trace(
      { command, argvLength: argv.length, cwd: this.config.cwd },
      "cursor-cli spawn",
    );
    this.child = child;
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const rl = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          continue;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.dispatchStreamRecord(record, turnId, stderrChunks);
      }
    } finally {
      rl.close();
      this.child = null;
    }

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    const code = child.exitCode;
    if (this.activeForegroundTurnId !== turnId) {
      return;
    }

    const diagnostic = stderrChunks.join("").trim();
    if (code !== 0 && code !== null) {
      this.finishTurn({
        type: "turn_failed",
        provider: this.provider,
        error: `Cursor agent exited with code ${code}`,
        diagnostic: diagnostic || undefined,
        turnId,
      });
      return;
    }

    this.finishTurn({
      type: "turn_completed",
      provider: this.provider,
      turnId,
    });
  }

  private dispatchStreamRecord(
    record: Record<string, unknown>,
    turnId: string,
    stderrChunks: string[],
  ): void {
    if (this.activeForegroundTurnId !== turnId) {
      return;
    }

    const type = record.type;
    if (type === "system" && record.subtype === "init") {
      const sid = typeof record.session_id === "string" ? record.session_id : null;
      if (sid) {
        this.sessionId = sid;
        if (this.bootstrapThreadEventPending) {
          this.bootstrapThreadEventPending = false;
          this.pushEvent({
            type: "thread_started",
            provider: this.provider,
            sessionId: sid,
          });
        }
      }
      return;
    }

    if (type === "user") {
      // Cursor stream-json replays the submitted prompt as `user` messages. Paseo already
      // inserts the canonical bubble via AgentManager.recordUserMessage() before streaming.
      // Those rows carry client messageId; CLI output does not, so handleStreamEvent cannot
      // dedupe and the UI shows duplicate bubbles. Tool / continuation traffic is not
      // modeled as `user` in this headless print path.
      return;
    }

    if (type === "assistant") {
      const text = extractAssistantText(record.message);
      if (text) {
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text },
        });
      }
      return;
    }

    if (type === "tool_call") {
      const callId = typeof record.call_id === "string" ? record.call_id : randomUUID();
      const subtype = typeof record.subtype === "string" ? record.subtype : "";
      const item = mapToolCallToTimeline(callId, subtype, record);
      if (item) {
        this.pushEvent({ type: "timeline", provider: this.provider, turnId, item });
      }
      return;
    }

    if (type === "result") {
      const isError = Boolean(record.is_error);
      const usage = mapStreamJsonUsage(record.usage);
      if (isError) {
        const msg =
          typeof record.result === "string"
            ? record.result
            : typeof record.error === "string"
              ? record.error
              : "Cursor agent run failed";
        this.finishTurn({
          type: "turn_failed",
          provider: this.provider,
          error: msg,
          diagnostic: stderrChunks.join("").trim() || undefined,
          turnId,
        });
        return;
      }
      this.finishTurn({
        type: "turn_completed",
        provider: this.provider,
        usage,
        turnId,
      });
    }
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private finishTurn(
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  ): void {
    this.activeForegroundTurnId = null;
    this.pushEvent(event);
  }
}

// #endregion
