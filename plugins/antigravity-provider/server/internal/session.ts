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
import { contextWindowForModel, validateSelection } from "./catalog.js";
import { PromptFiles } from "./prompt.js";
import { toolItem } from "./timeline.js";
import { AntigravityError, diagnostic, type Frame, type Step } from "./wire.js";

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ conversationId: z.string().min(1) }).strict() })
  .strict();
interface Turn {
  id: string;
  leg: number;
  legStarted: boolean;
  activeTools: Set<number>;
  pendingSteer: string[];
  steering: boolean;
  steerTimer: ReturnType<typeof setTimeout> | null;
  text: Map<string, string>;
  usageSteps: Set<string>;
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
    this.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.state.type === "running") {
      if (prompt.delivery !== "steer") {
        throw new AntigravityError(
          "Antigravity already has an active turn; wait for it to finish",
          "TURN_ACTIVE",
        );
      }
      const { turn } = this.state;
      const { text, nativeText } = await this.promptFiles.encode(prompt);
      if (this.state.type !== "running" || this.state.turn !== turn) {
        this.emit({
          type: "session.prompt_result",
          sessionId: this.options.id,
          clientMessageId: prompt.clientMessageId,
          result: {
            type: "failed",
            error: { message: "Active turn finished before steer", code: "TURN_INACTIVE" },
          },
        });
        return;
      }
      turn.pendingSteer.push(nativeText);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: turn.id },
      });
      this.item({
        type: "user_message",
        id: prompt.clientMessageId,
        clientMessageId: prompt.clientMessageId,
        text,
      });
      this.scheduleSteerFlush(turn);
      return;
    }
    if (prompt.delivery === "steer") {
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.id,
        clientMessageId: prompt.clientMessageId,
        result: {
          type: "failed",
          error: { message: "No active turn to steer", code: "TURN_INACTIVE" },
        },
      });
      return;
    }
    const { text, nativeText } = await this.promptFiles.encode(prompt);
    await this.ensureDriver();
    if (this.state.type !== "idle") throw new AntigravityError("Antigravity session is not ready");
    const driver = this.state.driver;
    const turn: Turn = {
      id: randomUUID(),
      leg: 0,
      legStarted: false,
      activeTools: new Set(),
      pendingSteer: [],
      steering: false,
      steerTimer: null,
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
      this.failTurn(driver, new AntigravityError(error.message));
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
    const driver: Driver = startDriver({
      launch: this.options.launch,
      config: this.config,
      conversationId: this.conversationId,
      onFrame: (frame) => this.accept(driver, frame),
      onExit: (error) => this.failTurn(driver, error),
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

  private accept(driver: Driver, frame: Frame): void {
    if (this.state.type !== "running" || this.state.driver !== driver) return;
    const { turn } = this.state;
    if (frame.event === "step_update") {
      this.acceptStep(frame.step_update, turn);
      return;
    }
    if (frame.event !== "result") return;
    if (turn.steering) return;
    const result = frame.result;
    const denied = takeNewDenials(result.denied_actions, this.reportedDenials);
    if (denied.length > 0) {
      this.emit({
        type: "session.notice",
        sessionId: this.options.id,
        notice: {
          id: turn.leg === 0 ? `${turn.id}:denied` : `${turn.id}:${turn.leg}:denied`,
          severity: "warning",
          title: denialNoticeTitle(denied),
          description: "Antigravity's own policy denied it.",
        },
      });
    }
    if (result.status === "ERROR") {
      const canceled = isInterruptedError(result.error);
      if (canceled && turn.pendingSteer.length > 0) {
        turn.activeTools.clear();
        this.scheduleSteerFlush(turn, true);
        return;
      }
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
      turn.activeTools.clear();
      if (turn.pendingSteer.length > 0) {
        this.finishTools(turn, "completed");
        if (driver.selection !== selection(this.config)) {
          this.scheduleSteerFlush(turn, true);
          return;
        }
        this.clearSteerTimer(turn);
        turn.leg += 1;
        turn.legStarted = false;
        const combined = turn.pendingSteer.splice(0).join("\n\n");
        void driver.prompt(combined).then(
          () => {
            this.firstMessage = false;
            if (turn.pendingSteer.length > 0) this.scheduleSteerFlush(turn);
            return undefined;
          },
          (error: unknown) => {
            const failure =
              error instanceof AntigravityError
                ? error
                : new AntigravityError(error instanceof Error ? error.message : String(error));
            this.failTurn(driver, failure);
            void driver.stop("interrupt");
          },
        );
        return;
      }
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
    turn.legStarted = true;
    const stepKey = turn.leg === 0 ? `${step.step_index}` : `${turn.leg}:${step.step_index}`;
    const id = `${turn.id}:${stepKey}`;
    if (step.step_type === "agent_response") {
      const previous = turn.text.get(stepKey) || "";
      const text = previous + step.text_delta;
      turn.text.set(stepKey, text);
      if (step.text_delta) this.item({ type: "assistant_message", id, messageId: id, text });
      if (step.state === "DONE" && step.usage && !turn.usageSteps.has(stepKey)) {
        turn.usageSteps.add(stepKey);
        turn.usage.inputTokens += step.usage.input_tokens;
        turn.usage.outputTokens += step.usage.output_tokens;
        turn.usage.cachedInputTokens += step.usage.cache_read_tokens;
        const contextWindowUsedTokens =
          step.usage.input_tokens + step.usage.cache_read_tokens + step.usage.output_tokens;
        const inferredMax = contextWindowForModel(this.config.model);
        const contextWindowMaxTokens =
          inferredMax !== undefined ? Math.max(inferredMax, contextWindowUsedTokens) : undefined;
        this.emit({
          type: "session.usage",
          sessionId: this.options.id,
          turnId: turn.id,
          usage: {
            ...turn.usage,
            ...(contextWindowUsedTokens > 0 ? { contextWindowUsedTokens } : {}),
            ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
          },
        });
      }
    } else if (step.step_type === "tool" || step.step_type === "subagent") {
      if (step.state === "ACTIVE") turn.activeTools.add(step.step_index);
      else turn.activeTools.delete(step.step_index);
      const item = toolItem(step, id);
      turn.tools.set(id, item);
      this.item(item);
    }
    if (turn.pendingSteer.length > 0 && turn.activeTools.size === 0) {
      this.scheduleSteerFlush(turn);
    }
  }

  private clearSteerTimer(turn: Turn): void {
    if (turn.steerTimer !== null) {
      clearTimeout(turn.steerTimer);
      turn.steerTimer = null;
    }
  }

  private scheduleSteerFlush(turn: Turn, allowUnstarted = false): void {
    if (this.state.type !== "running" || this.state.turn !== turn) return;
    if (turn.steering || turn.pendingSteer.length === 0 || turn.activeTools.size > 0) return;
    if (!turn.legStarted && !allowUnstarted) {
      if (turn.steerTimer === null) {
        turn.steerTimer = setTimeout(() => {
          turn.steerTimer = null;
          this.scheduleSteerFlush(turn, true);
        }, 200);
        turn.steerTimer.unref?.();
      }
      return;
    }
    this.clearSteerTimer(turn);
    queueMicrotask(() => {
      void this.flushSteer(turn);
    });
  }

  private async flushSteer(turn: Turn): Promise<void> {
    if (this.state.type !== "running" || this.state.turn !== turn) return;
    if (turn.steering || turn.pendingSteer.length === 0 || turn.activeTools.size > 0) return;
    if (this.conversationId === null) return;
    turn.steering = true;
    const oldDriver = this.state.driver;
    try {
      await oldDriver.stop("interrupt");
      if (this.state.type !== "running" || this.state.turn !== turn) return;
      this.reportedDenials.clear();
      const nextDriver: Driver = startDriver({
        launch: this.options.launch,
        config: this.config,
        conversationId: this.conversationId,
        onFrame: (frame) => this.accept(nextDriver, frame),
        onExit: (error) => this.failTurn(nextDriver, error),
      });
      this.state = { type: "running", driver: nextDriver, turn };
      const init = await nextDriver.ready;
      if (
        this.state.type !== "running" ||
        this.state.turn !== turn ||
        this.state.driver !== nextDriver
      ) {
        await nextDriver.stop("interrupt");
        return;
      }
      if (init.conversation_id !== this.conversationId) {
        throw new AntigravityError(
          "Antigravity restored a different conversation",
          "INVALID_RESUME",
        );
      }
      this.finishTools(turn, "canceled");
      turn.leg += 1;
      turn.legStarted = false;
      turn.steering = false;
      const combined = turn.pendingSteer.splice(0).join("\n\n");
      if (!combined) return;
      await nextDriver.prompt(combined);
      this.firstMessage = false;
      if (turn.pendingSteer.length > 0) {
        this.scheduleSteerFlush(turn);
      }
    } catch (error) {
      turn.steering = false;
      if (this.state.type !== "running" || this.state.turn !== turn) return;
      const failure =
        error instanceof AntigravityError
          ? error
          : new AntigravityError(error instanceof Error ? error.message : String(error));
      this.failTurn(this.state.driver, failure);
    }
  }

  private failTurn(driver: Driver, error: AntigravityError): void {
    const state = this.state;
    if ((state.type !== "running" && state.type !== "idle") || state.driver !== driver) return;
    if (state.type === "running" && state.turn.steering) return;
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
    this.clearSteerTimer(turn);
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

function isInterruptedError(error: string): boolean {
  return error === "interrupted" || error.includes("The stream was interrupted");
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
