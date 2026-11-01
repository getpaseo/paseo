import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    this.emit({ type: "session.commands", sessionId: this.options.id, commands: [] });
    await this.replayTranscript();
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
    const homedir = os.homedir();
    const candidatePaths = [
      path.join(homedir, ".gemini", "antigravity-cli", "brain", this.conversationId, ".system_generated", "logs", "transcript.jsonl"),
      path.join(homedir, ".gemini", "antigravity", "brain", this.conversationId, ".system_generated", "logs", "transcript.jsonl"),
    ];
    let transcriptPath: string | null = null;
    for (const cand of candidatePaths) {
      if (fs.existsSync(cand)) {
        transcriptPath = cand;
        break;
      }
    }
    if (!transcriptPath) return;

    try {
      const content = await fs.promises.readFile(transcriptPath, "utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const steps: any[] = [];
      for (const line of lines) {
        try {
          steps.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT") {
          let text = typeof step.content === "string" ? step.content : "";
          const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (match) {
            text = match[1].trim();
          } else {
            text = text
              .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
              .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
              .trim();
          }
          if (text) {
            this.item({
              type: "user_message",
              id: `history-step-${step.step_index}`,
              clientMessageId: `history-step-${step.step_index}`,
              text,
            });
          }
        } else if (step.type === "PLANNER_RESPONSE" && step.source === "MODEL") {
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            const nextStep = steps[i + 1];
            for (let toolIdx = 0; toolIdx < step.tool_calls.length; toolIdx++) {
              const tc = step.tool_calls[toolIdx];
              const callId = `history-step-${step.step_index}-tool-${toolIdx}`;
              let output = "";
              let isError = false;
              if (nextStep && nextStep.type === "GENERIC") {
                output = typeof nextStep.content === "string" ? nextStep.content : "";
                if (nextStep.status === "ERROR" || nextStep.error) {
                  isError = true;
                  output = nextStep.error || output;
                }
              }

              const toolName = tc.name || "Antigravity tool";
              const rawArgs = tc.args || {};
              const args: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(rawArgs)) {
                args[k] = cleanArg(v);
              }
              const targetPath = (args.AbsolutePath || args.TargetFile || args.Path) as string | undefined;
              let detail: ProviderToolCallDetail;

              if (toolName === "run_command" && typeof args.CommandLine === "string") {
                detail = { type: "shell", command: args.CommandLine, output };
              } else if ((toolName === "read_file" || toolName === "view_file") && typeof targetPath === "string") {
                detail = { type: "read", filePath: targetPath, content: output };
              } else if ((toolName === "write_file" || toolName === "write_to_file") && typeof targetPath === "string") {
                detail = { type: "write", filePath: targetPath, content: (args.Content as string) || output };
              } else if ((toolName === "edit_file" || toolName === "replace_file_content" || toolName === "multi_replace_file_content") && typeof targetPath === "string") {
                detail = { type: "edit", filePath: targetPath };
              } else {
                detail = { type: "unknown", input: args, output };
              }

              this.item({
                type: "tool_call",
                id: callId,
                callId,
                name: toolName,
                status: isError ? "failed" : "completed",
                error: isError ? (output || "Tool failed") : null,
                detail,
              });
            }
          }
          if (step.content && typeof step.content === "string" && step.content.trim()) {
            this.item({
              type: "assistant_message",
              id: `history-step-${step.step_index}`,
              messageId: `history-step-${step.step_index}`,
              text: step.content,
            });
          }
        }
      }
    } catch {
      // Replay failure should not block session startup
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


function cleanArg(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") return parsed;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed;
  }
  return val;
}
