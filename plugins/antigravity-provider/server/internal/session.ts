import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderCommand,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderLaunch,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { startDriver, selection, type Driver } from "./process.js";
import {
  GEMINI_THINKING_OPTIONS,
  getModelContextWindow,
  supportsEffort,
  validateSelection,
} from "./catalog.js";
import { PromptFiles } from "./prompt.js";
import { toolItem } from "./timeline.js";
import { AntigravityError, diagnostic, type Frame, type Step } from "./wire.js";

const BUILTIN_COMMANDS: readonly ProviderCommand[] = [
  { name: "plan", description: "Plan carefully before executing a task." },
  {
    name: "compact",
    description: "Compact the conversation now (summarize history to free up the context window).",
  },
  {
    name: "goal",
    description: "Run until the specified goal is completely finished.",
  },
  { name: "grill-me", description: "Interview me to align on a plan." },
  {
    name: "learn",
    description: "Reflect on recent successes or corrections to capture reusable skills or rules.",
  },
  { name: "browser", description: "Invoke a browser agent for web tasks." },
  {
    name: "schedule",
    description: "Run an instruction on a recurring schedule or as a one-time timer.",
  },
  {
    name: "usage",
    description: "Show Antigravity 5-hour and weekly quota usage.",
  },
];

function discoverCommands(cwd: string | undefined, homeDir: string): ProviderCommand[] {
  const seen = new Set<string>();
  const result: ProviderCommand[] = [];
  for (const cmd of BUILTIN_COMMANDS) {
    seen.add(cmd.name);
    result.push({ ...cmd });
  }
  const skillDirs = [
    ...(cwd ? [path.join(cwd, ".agent", "skills")] : []),
    path.join(homeDir, ".gemini", "antigravity-cli", "skills"),
    path.join(homeDir, ".gemini", "antigravity-cli", "builtin", "skills"),
  ];
  for (const dir of skillDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillMd = path.join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(skillMd, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      let name = entry.name;
      let description = `Run skill ${entry.name}`;
      if (fmMatch) {
        const nameMatch = /^name:\s*(.+)$/m.exec(fmMatch[1]);
        const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }
      if (!seen.has(name)) {
        seen.add(name);
        result.push({ name, description });
      }
    }
  }
  return result;
}

const persistenceSchema = z
  .object({
    version: z.literal(1),
    data: z.object({ conversationId: z.string().min(1) }).strict(),
  })
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
  history?: "replay" | "skip";
  catalog(): ProviderCatalog;
  persistence?: ProviderPersistence;
  emit(event: ProviderEvent): void;
}

interface SavedContextUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usedTokens: number;
}

interface ReplayHistoryOptions {
  conversationId: string | null;
  sessionId: string;
  homeDir: string;
  emit: (event: ProviderEvent) => void;
}

const transcriptLineSchema = z.object({
  step_index: z.number().optional(),
  type: z.string().optional(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  created_at: z.string().optional(),
  input_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

function extractUserText(content: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  return (match ? match[1] : content).trim();
}

function resolveTranscriptPath(conversationId: string, homeDir: string): string {
  const logDir = path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  const fullPath = path.join(logDir, "transcript_full.jsonl");
  if (fs.existsSync(fullPath)) return fullPath;
  return path.join(logDir, "transcript.jsonl");
}

function readTranscriptContent(conversationId: string | null, homeDir: string): string | null {
  if (!conversationId) return null;
  try {
    return fs.readFileSync(resolveTranscriptPath(conversationId, homeDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function replayHistoryFromTranscript(options: ReplayHistoryOptions): void {
  const { conversationId, sessionId, homeDir, emit } = options;
  const content = readTranscriptContent(conversationId, homeDir);
  if (!content) return;

  const lines = content.trim().split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = transcriptLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const obj = parsed.data;
    const stepKey = obj.step_index ?? index;
    if (obj.type === "USER_INPUT" && typeof obj.content === "string") {
      const text = extractUserText(obj.content);
      if (!text) continue;
      emit({
        type: "timeline.item",
        sessionId,
        timestamp: obj.created_at,
        item: {
          type: "user_message",
          id: `user-${stepKey}`,
          messageId: `user-${stepKey}`,
          text,
        },
      });
    } else if (obj.type === "PLANNER_RESPONSE") {
      if (typeof obj.thinking === "string" && obj.thinking.trim().length > 0) {
        emit({
          type: "timeline.item",
          sessionId,
          timestamp: obj.created_at,
          item: {
            type: "reasoning",
            id: `reasoning-${stepKey}`,
            text: obj.thinking.trim(),
          },
        });
      }
      if (typeof obj.content === "string" && obj.content.trim().length > 0) {
        emit({
          type: "timeline.item",
          sessionId,
          timestamp: obj.created_at,
          item: {
            type: "assistant_message",
            id: `assistant-${stepKey}`,
            messageId: `assistant-${stepKey}`,
            text: obj.content,
          },
        });
      }
    }
  }
}

function readStepThinking(
  conversationId: string | null,
  stepIndex: number,
  homeDir: string,
): string | null {
  const content = readTranscriptContent(conversationId, homeDir);
  if (!content) return null;
  const lines = content.trim().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const parsed = transcriptLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const obj = parsed.data;
    if (
      obj.step_index === stepIndex &&
      typeof obj.thinking === "string" &&
      obj.thinking.trim().length > 0
    ) {
      return obj.thinking.trim();
    }
  }
  return null;
}

function readLastContextUsage(
  conversationId: string | null,
  homeDir: string,
): SavedContextUsage | null {
  const content = readTranscriptContent(conversationId, homeDir);
  if (!content) return null;

  const lines = content.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const parsed = transcriptLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const obj = parsed.data;
    if (typeof obj.input_tokens === "number") {
      const inputTokens = obj.input_tokens;
      const cachedInputTokens = obj.cache_read_tokens ?? 0;
      const outputTokens = obj.output_tokens ?? 0;
      return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        usedTokens: inputTokens + cachedInputTokens + outputTokens,
      };
    }
  }
  return null;
}

export class Session {
  private state: State = { type: "dormant" };
  private config: ProviderSessionConfig;
  private conversationId: string | null;
  private firstMessage: boolean;
  private readonly promptFiles = new PromptFiles();
  private readonly reportedDenials = new Map<string, number>();

  constructor(private readonly options: SessionOptions) {
    this.config = {
      ...options.config,
      mode: options.config.mode ?? "full-access",
    };
    this.conversationId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.conversationId
      : null;
    this.firstMessage = this.conversationId === null;
    validateSelection(this.config, options.catalog());
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    await this.ensureDriver();
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
    this.publishFullAccessNotice();
    this.publishConfig();
    const homeDir = this.resolveHomeDir();
    this.emit({
      type: "session.commands",
      sessionId: this.options.id,
      commands: discoverCommands(this.config.cwd, homeDir),
    });

    if (this.options.history === "replay") {
      replayHistoryFromTranscript({
        conversationId: this.conversationId,
        sessionId: this.options.id,
        homeDir,
        emit: (e) => this.emit(e),
      });
    }

    const lastUsage = readLastContextUsage(this.conversationId, homeDir);
    const currentModelId = this.config.model;
    const catalogModel = currentModelId
      ? this.options.catalog().models.find((m) => m.id === currentModelId)
      : undefined;
    const contextWindowMaxTokens =
      catalogModel?.contextWindowMaxTokens ??
      (currentModelId ? getModelContextWindow(currentModelId) : 1_048_576);

    if (lastUsage) {
      this.emit({
        type: "session.usage",
        sessionId: this.options.id,
        usage: {
          inputTokens: lastUsage.inputTokens,
          cachedInputTokens: lastUsage.cachedInputTokens,
          outputTokens: lastUsage.outputTokens,
          contextWindowMaxTokens,
          contextWindowUsedTokens: lastUsage.usedTokens,
        },
      });
    }
    this.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.state.type === "running") {
      await this.interrupt();
    }
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
    const nextSettings = { ...this.config.settings };
    if (changes.settings) {
      for (const [key, value] of Object.entries(changes.settings)) {
        if (key !== "sandbox") {
          throw new AntigravityError(`Unknown Antigravity setting: ${key}`);
        }
        nextSettings.sandbox = Boolean(value);
      }
    }
    const config = {
      ...this.config,
      model: changes.model === null ? undefined : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "full-access" : (changes.mode ?? this.config.mode),
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
      settings: nextSettings,
    };
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
        const thinking = readStepThinking(
          this.conversationId,
          step.step_index,
          this.resolveHomeDir(),
        );
        if (thinking) {
          this.item({
            type: "reasoning",
            id: `${turn.id}:reasoning:${step.step_index}`,
            text: thinking,
          });
        }
        turn.usage.inputTokens += step.usage.input_tokens;
        turn.usage.outputTokens += step.usage.output_tokens;
        turn.usage.cachedInputTokens += step.usage.cache_read_tokens;
        const currentModelId = this.config.model;
        const catalogModel = currentModelId
          ? this.options.catalog().models.find((m) => m.id === currentModelId)
          : undefined;
        const contextWindowMaxTokens =
          catalogModel?.contextWindowMaxTokens ??
          (currentModelId ? getModelContextWindow(currentModelId) : 1_048_576);
        const contextWindowUsedTokens =
          step.usage.input_tokens + step.usage.cache_read_tokens + step.usage.output_tokens;
        this.emit({
          type: "session.usage",
          sessionId: this.options.id,
          turnId: turn.id,
          usage: {
            ...turn.usage,
            contextWindowMaxTokens,
            contextWindowUsedTokens,
          },
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

  private resolveHomeDir(): string {
    return (
      this.config.env?.HOME ?? this.options.launch?.env?.HOME ?? process.env.HOME ?? os.homedir()
    );
  }

  private publishConfig(): void {
    const model = this.config.model;
    const suffixMatch = model ? /^(gemini-[^]+)-(low|medium|high)$/.exec(model) : null;
    let defaultEffort: string | undefined;
    if (suffixMatch) {
      defaultEffort = suffixMatch[2];
    } else if (supportsEffort(model)) {
      defaultEffort = "high";
    }
    const inferredEffort = this.config.thinkingOption ?? defaultEffort;
    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "full-access",
        thinkingOption: inferredEffort,
        models: this.options.catalog().models,
        modes: this.options.catalog().modes,
        thinkingOptions: supportsEffort(model) ? [...GEMINI_THINKING_OPTIONS] : [],
        settings: [
          {
            type: "toggle",
            id: "sandbox",
            label: "Sandbox",
            description: "Run in a sandbox with terminal restrictions enabled (--sandbox)",
            value: Boolean(this.config.settings?.sandbox),
          },
        ],
      },
    });
  }
  private item(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.options.id, item });
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
