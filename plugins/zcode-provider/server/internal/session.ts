import type { ProviderEvent, ProviderPrompt } from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent, ZCodeTransport } from "./transport.js";

export type TurnPhase = "idle" | "running" | "stopping" | "settled";

interface ActiveTurn {
  turnId: string;
  inputId: string;
  clientMessageId: string;
}

export interface ZCodeSessionOptions {
  id: string;
  transport: ZCodeTransport;
  emit(event: ProviderEvent): void;
}

export class ZCodeSession {
  private phase: TurnPhase = "idle";
  /**
   * Turns are tracked per input id, not in a single slot. A second prompt can
   * be dispatched while the first turn is still running, and a single slot
   * would attribute the first turn's completion to the second turn.
   */
  private readonly turns = new Map<string, ActiveTurn>();
  /** ZCode's own turn id to the Paseo turn id it corresponds to. */
  private readonly nativeTurnIds = new Map<string, string>();
  /** The most recently started turn, used when an event carries no usable id. */
  private activeTurnId: string | undefined;

  private nativeSessionId = "";
  private cancelInFlight: Promise<void> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ZCodeSessionOptions) {
    this.unsubscribe = options.transport.onEvent((event) => this.handleEvent(event));
  }

  async open(input: { cwd: string }): Promise<string> {
    const handle = await this.options.transport.createSession({
      workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
    });
    this.nativeSessionId = handle.sessionId;
    this.options.emit({
      type: "session.opened",
      sessionId: this.options.id,
      capabilities: this.options.transport.capabilities,
      restoration: "core",
      cwd: input.cwd,
      persistence: {
        version: 1,
        data: {
          nativeSessionId: handle.sessionId,
          workspaceKey: handle.workspace.workspaceKey,
          workspacePath: handle.workspace.workspacePath,
        },
      },
    });
    this.options.emit({ type: "session.ready", sessionId: this.options.id });
    return handle.sessionId;
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.cancelInFlight) {
      throw new Error("A cancel is still settling; wait for it before starting a new run");
    }
    if (this.phase === "stopping") {
      throw new Error("A cancel is still settling; wait for it before starting a new run");
    }
    if (prompt.delivery === "steer") {
      throw new Error("Steering is not supported on the legacy ZCode transport");
    }
    if (prompt.input.type === "command") {
      throw new Error("Slash commands are not supported on the legacy ZCode transport");
    }
    const unsupported = prompt.input.content.filter((part) => part.type !== "text");
    if (unsupported.length > 0) {
      // The daemon gates images behind prompt.image, which this transport does
      // not declare, so an image prompt never arrives. Attachments have no
      // capability gate, so the session rejects them itself. Dropping them
      // would run the turn without the content the user attached.
      throw new Error(
        `Attachments are not supported on the legacy ZCode transport: ${unsupported.map((part) => part.type).join(", ")}`,
      );
    }
    const text = prompt.input.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const turnId = `zcode-turn-${this.options.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputId = `paseo-input-${prompt.clientMessageId}`;
    this.phase = "running";
    this.turns.set(inputId, { turnId, inputId, clientMessageId: prompt.clientMessageId });
    await this.options.transport.send({
      sessionId: this.nativeSessionId,
      content: text,
      inputId,
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
  }

  interrupt(): Promise<void> {
    if (this.cancelInFlight) return this.cancelInFlight;
    this.phase = "stopping";
    this.cancelInFlight = this.settleCancel(this.cancelTarget());
    return this.cancelInFlight;
  }

  /**
   * Runs the cancel and settles the turn it stopped. A cancel that lands leaves
   * the session ready for the next run. A cancel that fails leaves the session
   * in "stopping", because the turn may still be running in ZCode.
   */
  private async settleCancel(cancelledTurnId: string | undefined): Promise<void> {
    try {
      await this.options.transport.stop({ sessionId: this.nativeSessionId });
    } catch (error) {
      this.cancelInFlight = undefined;
      // The failed terminal is the caller's answer for the turn, not the end
      // of the stop: the session keeps refusing new runs until a stop lands.
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: cancelledTurnId ?? "zcode-turn-unknown",
        state: "failed",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    this.cancelInFlight = undefined;
    // The caller is owed a terminal. ZCode may or may not send one after
    // a stop, so the provider emits the terminal itself and ignores the
    // event that follows. The phase has to leave "stopping" too, or the
    // session refuses every later prompt.
    this.phase = "settled";
    if (cancelledTurnId) {
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: cancelledTurnId,
        state: "canceled",
      });
    }
  }

  /**
   * The turn a cancel applies to. ZCode stops the session's current turn, so
   * the turn that started natively wins. A turn that was dispatched but never
   * acknowledged by ZCode is still owed a terminal, so the most recently
   * dispatched turn is the fallback.
   */
  private cancelTarget(): string | undefined {
    return this.activeTurnId ?? [...this.turns.values()].at(-1)?.turnId;
  }

  private handleEvent(event: ZCodeEvent): void {
    if (event.type === "turn.started") {
      this.handleTurnStarted(event);
      return;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      this.handleTurnFinished(event);
    }
  }

  private handleTurnStarted(event: ZCodeEvent): void {
    const payload = event.payload as { inputId?: string } | undefined;
    const turn = payload?.inputId ? this.turns.get(payload.inputId) : undefined;
    if (turn) {
      if (event.turnId) this.nativeTurnIds.set(event.turnId, turn.turnId);
      this.activeTurnId = turn.turnId;
      this.options.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.turnId,
        state: "started",
      });
    }
  }

  private handleTurnFinished(event: ZCodeEvent): void {
    // A stopped turn already has its terminal: the provider emitted
    // "canceled" when the cancel settled.
    if (this.phase === "stopping" || this.phase === "settled") return;
    const turnId =
      (event.turnId ? this.nativeTurnIds.get(event.turnId) : undefined) ??
      this.activeTurnId ??
      [...this.turns.values()].at(-1)?.turnId;
    if (!turnId) return;
    if (event.turnId) this.nativeTurnIds.delete(event.turnId);
    for (const [key, value] of this.turns) {
      if (value.turnId === turnId) this.turns.delete(key);
    }
    this.phase = this.turns.size > 0 ? "running" : "idle";
    if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId,
      state: event.type === "turn.completed" ? "completed" : "failed",
    });
  }

  async close(): Promise<void> {
    this.unsubscribe();
    // The transport is shared by every session on this connection, so the
    // connection closes it, not the session.
  }
}
