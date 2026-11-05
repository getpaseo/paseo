import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderLaunch,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { startDriver, selection, type Driver } from "./process.js";
import { validateSelection } from "./catalog.js";
import { PromptFiles } from "./prompt.js";
import { toolItem } from "./timeline.js";
import { AntigravityError, diagnostic, type Frame, type Step } from "./wire.js";

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ conversationId: z.string().min(1) }).strict() })
  .strict();
interface Turn {
  id: string;
  text: Map<number, string>;
  usageSteps: Set<number>;
  tools: Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>;
  usage: Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">>;
}
type State =
  | { type: "dormant" }
  | { type: "starting"; driver: Driver }
  | { type: "idle"; driver: Driver }
  | { type: "running"; driver: Driver; turn: Turn }
  | { type: "stopping"; driver: Driver }
  | { type: "closed" };
interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  catalog(): ProviderCatalog;
  persistence?: ProviderPersistence;
  emit(event: ProviderEvent): void;
}

export class Session {
  private state: State = { type: "dormant" };
  private config: ProviderSessionConfig;
  private conversationId: string | null;
  private firstMessage: boolean;
  private readonly promptFiles = new PromptFiles();
  private readonly reportedDenials = new Map<string, number>();

  constructor(private readonly options: SessionOptions) {
    this.config = { ...options.config, mode: options.config.mode ?? "full-access" };
    this.conversationId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.conversationId
      : null;
    this.firstMessage = this.conversationId === null;
    validateSelection(this.config, options.catalog());
  }

  async open(
    requestId: string,
    capabilities: readonly string[],
    history?: "skip" | "replay",
  ): Promise<void> {
    if (this.conversationId === null) {
      await this.ensureDriver();
    }
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities,
      restoration: "core",
      persistence: this.config.persist ? this.persistence() : undefined,
      cwd: this.config.cwd,
      title: this.config.title,
    });
    if (history === "replay" && this.conversationId !== null) {
      await this.replayTranscript();
    }
    this.publishFullAccessNotice();
    this.publishConfig();
    this.emit({ type: "session.commands", sessionId: this.options.id, commands: [] });
    this.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.state.type === "running")
      throw new AntigravityError(
        "Antigravity already has an active turn; wait for it to finish",
        "TURN_ACTIVE",
      );
    const { text, nativeText } = await this.promptFiles.encode(prompt);
    await this.ensureDriver();
    if (this.state.type !== "idle") throw new AntigravityError("Antigravity session is not ready");
    const driver = this.state.driver;
    const turn: Turn = {
      id: randomUUID(),
      text: new Map(),
      usageSteps: new Set(),
      tools: new Map(),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    };
    this.state = { type: "running", driver, turn };
    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "started",
    });
    this.item({
      type: "user_message",
      id: prompt.clientMessageId,
      clientMessageId: prompt.clientMessageId,
      text,
    });
    const driverText =
      this.firstMessage && this.config.systemPrompt
        ? `${this.config.systemPrompt}\n\n${nativeText}`
        : nativeText;
    try {
      await driver.prompt(driverText);
      this.firstMessage = false;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.failTurn(new AntigravityError(error.message));
      await driver.stop("interrupt");
    }
  }

  configure(changes: ProviderConfigChanges): void {
    const config = {
      ...this.config,
      model: changes.model === null ? undefined : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "full-access" : (changes.mode ?? this.config.mode),
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
    };
    if (changes.settings && Object.keys(changes.settings).length > 0)
      throw new AntigravityError("Antigravity has no configurable settings");
    validateSelection(config, this.options.catalog());
    this.config = config;
    this.publishConfig();
  }

  async interrupt(): Promise<void> {
    if (this.state.type !== "running") return;
    const { driver, turn } = this.state;
    this.state = { type: "stopping", driver };
    await driver.stop("interrupt");
    this.finishTools(turn, "canceled");
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "canceled",
    });
    this.state = { type: "dormant" };
  }

  async close(): Promise<void> {
    const state = this.state;
    this.state = { type: "closed" };
    try {
      if (state.type !== "dormant" && state.type !== "closed") await state.driver.stop("close");
    } finally {
      await this.promptFiles.close();
    }
    if (state.type === "running") {
      this.finishTools(state.turn, "canceled");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: state.turn.id,
        state: "canceled",
      });
    }
  }

  private publishFullAccessNotice(): void {
    this.emit({
      type: "session.notice",
      sessionId: this.options.id,
      notice: {
        id: `${this.options.id}:full-access`,
        severity: "warning",
        title: "Antigravity is running with full access",
        description:
          "Antigravity's CLI cannot ask for permission when another app drives it, so Paseo starts it with --dangerously-skip-permissions. Every tool call, including shell commands, runs without asking.",
      },
    });
  }

  private async ensureDriver(): Promise<void> {
    if (this.state.type === "closed") throw new AntigravityError("Antigravity session is closed");
    if (this.state.type === "stopping") {
      await this.state.driver.stop("interrupt");
      this.state = { type: "dormant" };
    }
    if (this.state.type === "idle" && this.state.driver.selection !== selection(this.config)) {
      const driver = this.state.driver;
      this.state = { type: "stopping", driver };
      await driver.stop("close");
      this.state = { type: "dormant" };
    }
    if (this.state.type !== "dormant") return;
    this.reportedDenials.clear();
    const driver = startDriver({
      launch: this.options.launch,
      config: this.config,
      conversationId: this.conversationId,
      onFrame: (frame) => this.accept(frame),
      onExit: (error) => this.failTurn(error),
    });
    this.state = { type: "starting", driver };
    try {
      const init = await driver.ready;
      if (this.conversationId !== null && init.conversation_id !== this.conversationId)
        throw new AntigravityError(
          "Antigravity restored a different conversation",
          "INVALID_RESUME",
        );
      this.conversationId = init.conversation_id;
      this.state = { type: "idle", driver };
      if (this.config.persist)
        this.emit({
          type: "session.persistence",
          sessionId: this.options.id,
          persistence: this.persistence(),
        });
    } catch (error) {
      this.state = { type: "dormant" };
      await driver.stop("interrupt");
      throw error;
    }
  }

  private accept(frame: Frame): void {
    if (this.state.type !== "running") return;
    const { turn, driver } = this.state;
    if (frame.event === "step_update") {
      this.acceptStep(frame.step_update, turn);
      return;
    }
    if (frame.event !== "result") return;
    const result = frame.result;
    const denied = takeNewDenials(result.denied_actions, this.reportedDenials);
    if (denied.length > 0) {
      this.emit({
        type: "session.notice",
        sessionId: this.options.id,
        notice: {
          id: `${turn.id}:denied`,
          severity: "warning",
          title: denialNoticeTitle(denied),
          description: "Antigravity's own policy denied it.",
        },
      });
    }
    if (result.status === "ERROR") {
      const canceled = result.error === "interrupted";
      this.finishTools(turn, canceled ? "canceled" : "failed");
      this.retire(driver);
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: canceled ? "canceled" : "failed",
        error: { message: diagnostic(result.error) },
      });
    } else {
      this.finishTools(turn, "completed");
      this.state = { type: "idle", driver };
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "completed",
      });
    }
  }

  private acceptStep(step: Step, turn: Turn): void {
    const id = `${turn.id}:${step.step_index}`;
    if (step.step_type === "agent_response") {
      const previous = turn.text.get(step.step_index) || "";
      const text = previous + step.text_delta;
      turn.text.set(step.step_index, text);
      if (step.text_delta) this.item({ type: "assistant_message", id, messageId: id, text });
      if (step.state === "DONE" && step.usage && !turn.usageSteps.has(step.step_index)) {
        turn.usageSteps.add(step.step_index);
        turn.usage.inputTokens += step.usage.input_tokens;
        turn.usage.outputTokens += step.usage.output_tokens;
        turn.usage.cachedInputTokens += step.usage.cache_read_tokens;
        this.emit({
          type: "session.usage",
          sessionId: this.options.id,
          turnId: turn.id,
          usage: { ...turn.usage },
        });
      }
    } else if (step.step_type === "tool" || step.step_type === "subagent") {
      const item = toolItem(step, id);
      turn.tools.set(id, item);
      this.item(item);
    }
  }

  private failTurn(error: AntigravityError): void {
    const state = this.state;
    if (state.type !== "running" && state.type !== "idle") return;
    this.retire(state.driver);
    if (state.type === "running") {
      this.finishTools(state.turn, "failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: state.turn.id,
        state: "failed",
        error: { message: error.message, code: error.code },
      });
    } else
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.id,
        error: { message: error.message, code: error.code },
      });
  }

  private retire(driver: Driver): void {
    this.state = { type: "stopping", driver };
    void driver.stop("interrupt").then(() => {
      if (this.state.type === "stopping" && this.state.driver === driver)
        this.state = { type: "dormant" };
      return undefined;
    });
  }

  private finishTools(turn: Turn, status: "completed" | "failed" | "canceled"): void {
    for (const item of turn.tools.values()) {
      if (item.status !== "running") continue;
      if (status === "failed") this.item({ ...item, status, error: "Antigravity turn failed" });
      else this.item({ ...item, status, error: null });
    }
  }

  private persistence(): ProviderPersistence {
    if (this.conversationId === null) throw new AntigravityError("Antigravity has no conversation");
    return { version: 1, data: { conversationId: this.conversationId } };
  }

  private async replayTranscript(): Promise<void> {
    if (!this.conversationId) return;
    const env = { ...this.options.launch.env, ...this.config.env };
    const homeDir = env.HOME || os.homedir();
    const transcript = findTranscriptPath(homeDir, this.conversationId);
    if (!transcript) return;

    const stream = fs.createReadStream(transcript.path, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let pendingTools: PendingToolBatch | null = null;
    let index = 0;

    try {
      for await (const line of rl) {
        const step = parseTranscriptStepLine(line);
        if (!step) continue;
        const currentIndex = index++;

        if (pendingTools) {
          const consumed = this.consumePendingToolStep(pendingTools, step, transcript.compact);
          pendingTools = consumed.pendingTools;
          if (consumed.consumed) continue;
        }

        pendingTools = this.replayStep(step, currentIndex);
      }
      if (pendingTools) {
        this.flushPendingToolCalls(pendingTools, transcript.compact);
      }
    } catch {
      // Transcript replay failure should never block session startup.
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  private consumePendingToolStep(
    batch: PendingToolBatch,
    step: TranscriptStep,
    compact: boolean,
  ): { pendingTools: PendingToolBatch | null; consumed: boolean } {
    if (step.type === "GENERIC" && batch.results.length < batch.toolCalls.length) {
      batch.results.push(step);
      if (batch.results.length === batch.toolCalls.length) {
        this.flushPendingToolCalls(batch, compact);
        return { pendingTools: null, consumed: true };
      }
      return { pendingTools: batch, consumed: true };
    }
    this.flushPendingToolCalls(batch, compact);
    return { pendingTools: null, consumed: false };
  }

  private replayStep(step: TranscriptStep, index: number): PendingToolBatch | null {
    const stepIndex = typeof step.step_index === "number" ? step.step_index : index;
    const timestamp = typeof step.created_at === "string" ? step.created_at : undefined;

    if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT") {
      const rawText = extractUserRequestText(typeof step.content === "string" ? step.content : "");
      const text = stripSystemPromptPrefix(rawText, this.config.systemPrompt);
      if (text) {
        const id = `history-step-${stepIndex}`;
        this.item({ type: "user_message", id, messageId: id, text }, timestamp);
      }
      return null;
    }

    if (step.type !== "PLANNER_RESPONSE" || step.source !== "MODEL") return null;

    if (typeof step.thinking === "string" && step.thinking.trim()) {
      this.item(
        {
          type: "reasoning",
          id: `history-step-${stepIndex}-reasoning`,
          text: step.thinking.trim(),
        },
        timestamp,
      );
    }

    if (typeof step.content === "string" && step.content.trim()) {
      const id = `history-step-${stepIndex}`;
      this.item({ type: "assistant_message", id, messageId: id, text: step.content }, timestamp);
    }

    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      return {
        stepIndex,
        toolCalls: step.tool_calls,
        results: [],
        timestamp,
      };
    }

    return null;
  }

  private flushPendingToolCalls(batch: PendingToolBatch, compact: boolean): void {
    for (let toolIdx = 0; toolIdx < batch.toolCalls.length; toolIdx++) {
      const toolCall = batch.toolCalls[toolIdx];
      if (!toolCall) continue;
      const resultStep = batch.results[toolIdx];
      this.item(
        buildReplayedToolCallItem(toolCall, resultStep, batch.stepIndex, toolIdx, compact),
        batch.timestamp,
      );
    }
  }

  private publishConfig(): void {
    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "full-access",
        models: this.options.catalog().models,
        modes: this.options.catalog().modes,
        thinkingOptions: [],
        settings: [],
      },
    });
  }
  private item(item: ProviderTimelineItem, timestamp?: string): void {
    this.emit({
      type: "timeline.item",
      sessionId: this.options.id,
      item,
      ...(timestamp ? { timestamp } : {}),
    });
  }
  private emit(event: ProviderEvent): void {
    this.options.emit(event);
  }
}

// Native results contain every denial since this driver started, including repeated actions.
function takeNewDenials(
  actions: Extract<Frame, { event: "result" }>["result"]["denied_actions"],
  reported: Map<string, number>,
) {
  const counts = new Map<string, number>();
  const fresh = actions.filter((action) => {
    const key = JSON.stringify([action.action, action.display_name]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > (reported.get(key) ?? 0);
  });
  for (const [key, count] of counts) reported.set(key, Math.max(count, reported.get(key) ?? 0));
  return fresh;
}

function denialNoticeTitle(
  actions: Extract<Frame, { event: "result" }>["result"]["denied_actions"],
): string {
  if (actions.length > 1) return `${actions.length} actions denied`;
  return actions[0].action === "command" ? "Shell command denied" : "Action denied";
}

const transcriptToolCallSchema = z.object({
  name: z.unknown().optional(),
  args: z.unknown().optional(),
});

const transcriptStepSchema = z.object({
  step_index: z.unknown().optional(),
  source: z.unknown().optional(),
  type: z.unknown().optional(),
  status: z.unknown().optional(),
  created_at: z.unknown().optional(),
  content: z.unknown().optional(),
  thinking: z.unknown().optional(),
  error: z.unknown().optional(),
  tool_calls: z.array(transcriptToolCallSchema).optional(),
});

type TranscriptToolCall = z.infer<typeof transcriptToolCallSchema>;
type TranscriptStep = z.infer<typeof transcriptStepSchema>;

const subagentOutputSchema = z.object({
  conversationId: z.string().min(1).optional(),
  logAbsoluteUri: z.string().min(1).optional(),
});

interface TranscriptLocation {
  readonly path: string;
  readonly compact: boolean;
}

interface PendingToolBatch {
  readonly stepIndex: number;
  readonly toolCalls: readonly TranscriptToolCall[];
  readonly results: TranscriptStep[];
  readonly timestamp?: string;
}

function extractUserRequestText(rawContent: string): string {
  const match = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

function stripSystemPromptPrefix(text: string, systemPrompt?: string): string {
  if (!systemPrompt) return text;
  const prefix = `${systemPrompt}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

type JsonScalarOrObject = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

function unquoteCompactString(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function cleanJsonArg(value: unknown, compact: boolean): JsonScalarOrObject {
  if (typeof value === "string") {
    return compact ? unquoteCompactString(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cleanJsonArg(entry, compact));
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonScalarOrObject> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = cleanJsonArg(entry, compact);
    }
    return out;
  }
  return String(value ?? "");
}

function cleanToolArgs(rawArgs: unknown, compact: boolean): Record<string, JsonScalarOrObject> {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return {};
  const args: Record<string, JsonScalarOrObject> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    args[key] = cleanJsonArg(value, compact);
  }
  return args;
}

function isSafeConversationId(conversationId: string): boolean {
  return (
    Boolean(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".." &&
    path.basename(conversationId) === conversationId &&
    !conversationId.includes("/") &&
    !conversationId.includes("\\")
  );
}

function findTranscriptPath(homeDir: string, conversationId: string): TranscriptLocation | null {
  if (!isSafeConversationId(conversationId)) return null;
  const roots = ["antigravity-cli", "antigravity"];
  const files = [
    { name: "transcript_full.jsonl", compact: false },
    { name: "transcript.jsonl", compact: true },
  ] as const;
  for (const root of roots) {
    for (const file of files) {
      const candidate = path.join(
        homeDir,
        ".gemini",
        root,
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        file.name,
      );
      if (fs.existsSync(candidate)) return { path: candidate, compact: file.compact };
    }
  }
  return null;
}

function parseTranscriptStepLine(line: string): TranscriptStep | null {
  if (!line.trim()) return null;
  try {
    const parsed = transcriptStepSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    // Ignore malformed JSONL lines in local transcript logs.
    return null;
  }
}

function buildReplayedToolCallItem(
  toolCall: TranscriptToolCall,
  resultStep: TranscriptStep | undefined,
  stepIndex: number,
  toolIdx: number,
  compact: boolean,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const hasGenericResult = resultStep?.type === "GENERIC";
  const rawOutput =
    hasGenericResult && typeof resultStep.content === "string" ? resultStep.content : "";
  const isError =
    hasGenericResult && (resultStep.status === "ERROR" || typeof resultStep.error === "string");
  const output = isError && typeof resultStep?.error === "string" ? resultStep.error : rawOutput;
  const callId = `history-step-${stepIndex}-tool-${toolIdx}`;
  const toolName =
    typeof toolCall.name === "string" && toolCall.name ? toolCall.name : "Antigravity tool";
  const args = cleanToolArgs(toolCall.args, compact);
  const detail = buildReplayedToolDetail(toolName, args, output);

  if (!hasGenericResult) {
    return {
      type: "tool_call",
      id: callId,
      callId,
      name: toolName,
      status: "canceled",
      error: null,
      detail,
    };
  }
  if (isError) {
    return {
      type: "tool_call",
      id: callId,
      callId,
      name: toolName,
      status: "failed",
      error: output || "Antigravity tool failed",
      detail,
    };
  }
  return {
    type: "tool_call",
    id: callId,
    callId,
    name: toolName,
    status: "completed",
    error: null,
    detail,
  };
}

function rawStringArg(
  args: Record<string, JsonScalarOrObject>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function stringArg(
  args: Record<string, JsonScalarOrObject>,
  ...keys: string[]
): string | undefined {
  const value = rawStringArg(args, ...keys);
  return value ? value : undefined;
}

function parseSubagentOutput(output: string): { childSessionId?: string; log: string } {
  const jsonMatch = output.match(/Created the following subagent:\s*(\{[\s\S]*?\})/);
  if (!jsonMatch?.[1]) return { log: output };
  try {
    const parsed = subagentOutputSchema.safeParse(JSON.parse(jsonMatch[1]));
    if (!parsed.success) return { log: output };
    return {
      childSessionId: parsed.data.conversationId,
      log: parsed.data.logAbsoluteUri ?? output,
    };
  } catch {
    return { log: output };
  }
}

function buildSubagentDetail(
  args: Record<string, JsonScalarOrObject>,
  output: string,
): ProviderToolCallDetail {
  const subAgentType = stringArg(args, "TypeName");
  const description = stringArg(args, "Prompt");
  const { childSessionId, log } = parseSubagentOutput(output);
  return {
    type: "sub_agent",
    ...(subAgentType ? { subAgentType } : {}),
    ...(description ? { description } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    log,
  };
}

function buildFileToolDetail(
  toolName: string,
  targetPath: string,
  args: Record<string, JsonScalarOrObject>,
  output: string,
): ProviderToolCallDetail | null {
  if (toolName === "read_file" || toolName === "view_file") {
    return { type: "read", filePath: targetPath, content: output };
  }
  if (toolName === "write_file" || toolName === "write_to_file") {
    const content = rawStringArg(args, "Content", "CodeContent") ?? output;
    return { type: "write", filePath: targetPath, content };
  }
  if (
    toolName === "edit_file" ||
    toolName === "replace_file_content" ||
    toolName === "multi_replace_file_content"
  ) {
    const oldString = rawStringArg(args, "Target", "TargetContent");
    const newString = rawStringArg(args, "Replacement", "ReplacementContent");
    return {
      type: "edit",
      filePath: targetPath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
    };
  }
  return null;
}

function buildReplayedToolDetail(
  toolName: string,
  args: Record<string, JsonScalarOrObject>,
  output: string,
): ProviderToolCallDetail {
  if (toolName === "invoke_subagent") {
    return buildSubagentDetail(args, output);
  }
  const command = stringArg(args, "CommandLine");
  if (toolName === "run_command" && command) {
    const cwd = stringArg(args, "Cwd");
    return { type: "shell", command, ...(cwd ? { cwd } : {}), output };
  }
  const targetPath = stringArg(args, "AbsolutePath", "TargetFile", "Path");
  if (targetPath) {
    const fileDetail = buildFileToolDetail(toolName, targetPath, args, output);
    if (fileDetail) return fileDetail;
  }
  const query = stringArg(args, "query");
  if (toolName === "search_web" && query) {
    return { type: "search", query, toolName: "web_search", content: output };
  }
  const url = stringArg(args, "Url");
  if (toolName === "read_url_content" && url) {
    return { type: "fetch", url, result: output };
  }
  return { type: "unknown", input: args, output };
}
