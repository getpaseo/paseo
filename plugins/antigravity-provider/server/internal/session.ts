import { randomUUID } from "node:crypto";
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
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { startDriver, selection, type Driver } from "./process.js";
import { validateSelection } from "./catalog.js";
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

  constructor(private readonly options: SessionOptions) {
    this.config = options.config;
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
    const text = promptText(prompt);
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
    const nativeText =
      this.firstMessage && this.config.systemPrompt
        ? `${this.config.systemPrompt}\n\n${text}`
        : text;
    try {
      await driver.prompt(nativeText);
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
      mode: changes.mode === null ? undefined : (changes.mode ?? this.config.mode),
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
    if (state.type !== "dormant" && state.type !== "closed") await state.driver.stop("close");
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
    if (result.denied_actions.length > 0) {
      const denied = result.denied_actions.map((action) => action.display_name).join(", ");
      this.emit({
        type: "session.notice",
        sessionId: this.options.id,
        notice: {
          id: `${turn.id}:denied`,
          severity: "warning",
          title: `Antigravity denied: ${denied}`,
          description:
            "Choose Full access and send another prompt to allow shell commands. Default, Accept edits and Plan deny shell commands.",
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

  private publishConfig(): void {
    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "default",
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

function promptText(prompt: ProviderPrompt): string {
  if (
    prompt.input.type !== "message" ||
    prompt.delivery === "steer" ||
    prompt.outputSchema !== undefined
  )
    throw new AntigravityError("Antigravity supports text messages only");
  const text: string[] = [];
  for (const part of prompt.input.content) {
    if (part.type !== "text") throw new AntigravityError("Antigravity supports text content only");
    text.push(part.text);
  }
  return text.join("\n");
}
