import { structuredOutput } from "./structured-output.js";
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";

import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";

import { usageFromV2 } from "./mapping.js";
import { latestTurnMetrics } from "./metrics.js";

import { commands } from "./commands.js";

import type { V2Api } from "./api.js";

const INTERRUPT_SETTLE_POLL_MS = 25;
const INTERRUPT_SETTLE_MAX_POLLS = 80;
const INTERRUPT_RECONCILE_TIMEOUT_MS = 250;
const FALLBACK_EXECUTION_ERROR = "OpenCode execution failed";

type ExecutionEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.execution.started"
      | "session.execution.succeeded"
      | "session.execution.failed"
      | "session.execution.interrupted";
  }
>;
function isExecutionEvent(event: { type: string }): event is ExecutionEvent {
  return (
    event.type === "session.execution.started" ||
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  );
}

type TurnResolution =
  | { outcome: "succeeded" }
  | { outcome: "interrupted" }
  | { outcome: "failed"; error: string };

/** OpenCode >= 2.2.2 stamps `time.busy` on execution start; `@opencode/client` 2.0.10 omits it. */
function sessionBusyTime(info: SessionInfo): number | undefined {
  const busy: unknown = Reflect.get(info.time, "busy");
  return typeof busy === "number" && Number.isFinite(busy) ? busy : undefined;
}

/**
 * OpenCode projects `time.idle` and `outcome` atomically on succeeded, failed, and non-shutdown
 * interrupted executions, while skipping `reason: "shutdown"` so restart-resumable turns stay open.
 */
function isTurnFinalized(info: SessionInfo, turn: Turn): boolean {
  if (info.outcome === undefined || info.time.idle === undefined) return false;
  if (turn.baselineIdleTime !== undefined && info.time.idle <= turn.baselineIdleTime) return false;
  const busy = sessionBusyTime(info);
  if (busy !== undefined && info.time.idle < busy) return false;
  return true;
}

function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message: unknown = Reflect.get(value, "message");
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/**
 * Extracts a failure error from the newest tail messages (`order: "desc"`):
 * checks `idle.error.message` (OpenCode 2.1+) first, then the latest assistant step's error
 * (OpenCode 2.0.10-2.0.x), stopping at the prior turn boundary.
 */
function extractFailureMessage(tailDescending: readonly SessionMessageInfo[]): string {
  let seenIdle = false;
  for (const message of tailDescending) {
    if (message.type === "idle") {
      if (seenIdle) break;
      seenIdle = true;
      const idleError = readErrorMessage(Reflect.get(message, "error"));
      if (idleError) return idleError;
      continue;
    }
    if (message.type === "assistant") {
      const assistantError = readErrorMessage(message.error);
      if (assistantError) return assistantError;
      continue;
    }
    if (message.type === "user") break;
  }
  return FALLBACK_EXECUTION_ERROR;
}

async function waitForTurnOrPoll(
  completion: Promise<void>,
  pollMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const poll = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(true);
    timer = setTimeout(() => resolve(false), pollMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([completion.then(() => true), poll]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function waitForCompletionOrAbort(
  completion: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([completion, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

interface TurnSnapshot {
  info: SessionInfo;
  history: SessionMessageInfo[];
}
interface TurnOptions {
  client(): V2Api;
  id: string;
  cwd: string;
  signal: AbortSignal;
  logger?: Logger;
  sessionIdleTime(): number | undefined;
  updateInfo?(info: SessionInfo): void;
  emit(event: AgentStreamEvent): void;
  reconcile(): Promise<TurnSnapshot>;
  scheduleReconcile(): void;
  clearPermissions(): Promise<void>;
  reportReconciliationError(error: unknown): void;
}
interface Turn {
  output?: ReturnType<typeof structuredOutput>;
  id: string;
  submitted: Promise<void>;
  completion: Promise<void>;
  settle(): void;
  accepted: boolean;
  requestDenied: boolean;
  interruptRequested: boolean;
  baselineIdleTime: number | undefined;
}

export class SessionTurns {
  private turn: Turn | null = null;
  private stopping: Promise<void> | null = null;
  private stopFailed = false;
  private revision = 0;
  private execution: ExecutionEvent | null = null;
  private sequence = 0;
  private refresh: Promise<void> | null = null;
  private dirty = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: TurnOptions) {}
  get id() {
    return this.turn?.id;
  }
  get hasStructuredOutput() {
    return Boolean(this.turn?.output);
  }
  fail(error: Error) {
    const turn = this.turn;
    if (!turn) return;
    this.release(turn);
    this.options.emit({
      type: "turn_failed",
      provider: "opencode",
      turnId: turn.id,
      error: toDiagnosticErrorMessage(error),
    });
  }
  private release(turn: Turn) {
    this.turn = null;
    this.revision += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    turn.settle();
  }
  close() {
    if (this.turn) this.release(this.turn);
  }
  private createTurn(submitted: Promise<void>, accepted: boolean, output?: Turn["output"]): Turn {
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = {
      id: randomUUID(),
      submitted,
      completion,
      settle,
      accepted,
      output,
      requestDenied: false,
      interruptRequested: false,
      baselineIdleTime: this.options.sessionIdleTime(),
    };
    this.turn = turn;
    this.execution = null;
    this.revision += 1;
    this.options.emit({ type: "turn_started", provider: "opencode", turnId: turn.id });
    this.scheduleRecovery();
    return turn;
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.stopping;
    if (this.options.signal.aborted) throw new Error("OpenCode session is closed");
    if (this.turn) throw new Error("OpenCode session already has an active turn");
    const input = this.promptInput(prompt);
    let accept!: () => void;
    const submitted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const output =
      options?.outputSchema === undefined ? undefined : structuredOutput(options.outputSchema);
    const turn = this.createTurn(submitted, false, output);
    void this.submit(turn, input, accept, options);
    return { turnId: turn.id };
  }
  private async submit(
    turn: Turn,
    input: ReturnType<SessionTurns["promptInput"]>,
    accept: () => void,
    options?: AgentRunOptions,
  ) {
    try {
      // Refresh baselineIdleTime before dispatch so an out-of-band turn completed while Paseo
      // was idle cannot falsely satisfy `time.idle > baselineIdleTime` on OpenCode < 2.2.2.
      try {
        const info = await this.options
          .client()
          .session.get({ sessionID: this.options.id }, { signal: this.options.signal });
        if (this.turn !== turn) return;
        turn.baselineIdleTime = info.time.idle;
        this.options.updateInfo?.(info);
      } catch {
        // Keep the cached baselineIdleTime if the pre-dispatch read fails transiently.
      }
      await this.dispatch(input, options, turn.output);
      if (this.turn !== turn) return;
      turn.accepted = true;
      this.revision += 1;
      // Covers a fast execution whose terminal event preceded the admission response.
      this.requestReconciliation();
    } catch (error) {
      if (this.turn === turn) this.fail(new Error(toDiagnosticErrorMessage(error)));
    } finally {
      accept();
    }
  }
  observe(event: OpenCodeEvent) {
    if (!isExecutionEvent(event) || event.durable.seq <= this.sequence) return;
    this.revision += 1;
    if (event.type === "session.execution.started") this.observeActiveTurn();
    this.execution = event;
    this.sequence = event.durable.seq;
    this.requestReconciliation();
  }
  // OpenCode ends the execution when the user denies its permission or dismisses its question,
  // but reports the interruption as "shutdown", the same reason as an execution it will resume.
  requestDenied() {
    if (!this.turn) return;
    this.turn.requestDenied = true;
    this.requestReconciliation();
  }
  private requestReconciliation() {
    void this.reconcile().catch((error: unknown) => this.options.reportReconciliationError(error));
  }
  // Recovery reads state; a quiet stream (including SSE comment heartbeats) is not a reason to reconnect.
  private scheduleRecovery() {
    if (this.retryTimer || !this.turn || this.options.signal.aborted) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestReconciliation();
    }, 5_000);
    this.retryTimer.unref();
  }
  reconcile(): Promise<void> {
    this.dirty = true;
    if (this.refresh) return this.refresh;
    this.refresh = Promise.resolve()
      .then(() => this.drainReconciliation())
      .finally(() => {
        this.refresh = null;
        this.scheduleRecovery();
      });
    return this.refresh;
  }
  private async drainReconciliation() {
    while (this.dirty && !this.options.signal.aborted) {
      this.dirty = false;
      await this.reconcileTurn();
    }
  }
  private logReconcileReturn(reason: string, turn: Turn | null, extra?: Record<string, unknown>) {
    this.options.logger?.debug(
      { sessionId: this.options.id, turnId: turn?.id, reason, ...extra },
      "OpenCode turn reconciliation returned early",
    );
  }
  private liveResolution(turn: Turn): TurnResolution | null {
    const execution = this.execution;
    if (!execution) return null;
    if (execution.type === "session.execution.succeeded") return { outcome: "succeeded" };
    if (execution.type === "session.execution.failed")
      return { outcome: "failed", error: execution.data.error.message };
    if (
      execution.type === "session.execution.interrupted" &&
      (execution.data.reason !== "shutdown" || turn.requestDenied || turn.interruptRequested)
    )
      return { outcome: "interrupted" };
    return null;
  }
  private async readFailureMessage(): Promise<string> {
    const page = await this.options
      .client()
      .message.list(
        { sessionID: this.options.id, order: "desc", limit: 5 },
        { signal: this.options.signal },
      );
    return extractFailureMessage(page.data);
  }
  private async resolvePersistedOutcome(
    turn: Turn,
    revision: number,
  ): Promise<TurnResolution | "stale" | null> {
    // OpenCode disables durable event log persistence by default, so recover missed terminal
    // SSE events from the persisted SessionInfo projection instead of session.log.
    const info = await this.options
      .client()
      .session.get({ sessionID: this.options.id }, { signal: this.options.signal });
    if (revision !== this.revision) {
      this.logReconcileReturn("revision_changed_after_session_get", turn);
      return "stale";
    }
    this.options.updateInfo?.(info);
    if (!isTurnFinalized(info, turn)) {
      if (turn.requestDenied || turn.interruptRequested) return { outcome: "interrupted" };
      this.logReconcileReturn("turn_not_finalized", turn, {
        outcome: info.outcome,
        idleTime: info.time.idle,
        busyTime: sessionBusyTime(info),
        baselineIdleTime: turn.baselineIdleTime,
      });
      return null;
    }
    if (info.outcome === "failed") {
      const error = await this.readFailureMessage();
      if (revision !== this.revision) {
        this.logReconcileReturn("revision_changed_after_failure_read", turn);
        return "stale";
      }
      return { outcome: "failed", error };
    }
    if (info.outcome === "interrupted") return { outcome: "interrupted" };
    return { outcome: "succeeded" };
  }
  private async settleImmediate(
    turn: Turn,
    resolution: Exclude<TurnResolution, { outcome: "succeeded" }>,
  ) {
    // Try a bounded tail snapshot before releasing the turn so final tool states (such as a
    // running tool marked error on Stop) arrive under this turn's id before turn_canceled or
    // turn_failed. If the read is slow or fails, settle anyway so Stop stays fast.
    let reconcileFailed = false;
    const catchUp = this.options.reconcile().then(
      () => undefined,
      (error: unknown) => {
        reconcileFailed = true;
        this.options.reportReconciliationError(error);
      },
    );
    await waitForTurnOrPoll(catchUp, INTERRUPT_RECONCILE_TIMEOUT_MS, this.options.signal);
    if (this.turn !== turn) return;
    this.release(turn);
    if (resolution.outcome === "interrupted") {
      this.options.emit({
        type: "turn_canceled",
        provider: "opencode",
        turnId: turn.id,
        reason: "OpenCode interrupted execution",
      });
    } else {
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: turn.id,
        error: resolution.error,
      });
    }
    if (reconcileFailed) this.options.scheduleReconcile();
  }
  private async reconcileTurn() {
    const revision = this.revision;
    const turn = this.turn;
    const active = await this.options.client().session.active({ signal: this.options.signal });
    if (revision !== this.revision) {
      this.logReconcileReturn("revision_changed_after_active", turn);
      this.dirty = true;
      return;
    }
    if (active[this.options.id]) {
      if (turn) this.logReconcileReturn("session_still_active", turn);
      this.observeActiveTurn();
      return;
    }
    if (!turn?.accepted) {
      if (turn) this.logReconcileReturn("turn_not_accepted", turn);
      return;
    }

    const resolution =
      this.liveResolution(turn) ?? (await this.resolvePersistedOutcome(turn, revision));
    if (resolution === "stale") {
      this.dirty = true;
      return;
    }
    if (!resolution) return;

    if (resolution.outcome !== "succeeded") {
      await this.settleImmediate(turn, resolution);
      return;
    }

    // Read the final history only after observing idle. Never turn an observation transport error into an execution failure.
    const snapshot = await this.options.reconcile();
    if (revision !== this.revision) {
      this.logReconcileReturn("revision_changed_after_snapshot", turn);
      this.dirty = true;
      return;
    }
    try {
      turn.output?.assert(snapshot.history);
      this.release(turn);
      this.options.emit({
        type: "turn_completed",
        provider: "opencode",
        turnId: turn.id,
        usage: usageFromV2(snapshot.info),
        metrics: latestTurnMetrics(snapshot.history),
      });
    } catch (error) {
      if (this.turn === turn) this.fail(new Error(toDiagnosticErrorMessage(error)));
    }
  }
  private async dispatch(
    input: ReturnType<SessionTurns["promptInput"]>,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    const command = input.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (command?.[1] === "compact" || command?.[1] === "summarize") {
      await this.options.client().session.compact({ sessionID: this.options.id });
      return;
    }
    const selected = command
      ? (await commands(this.options.client(), this.options.cwd)).find(
          (item) => item.name === command[1],
        )
      : undefined;
    if (selected && selected.kind !== "skill") {
      await this.options.client().session.command({
        sessionID: this.options.id,
        name: selected.name,
        text: command?.[2] ?? "",
        files: input.files,
      });
      return;
    }
    await this.options.client().session.prompt({
      sessionID: this.options.id,
      ...input,
      ...(selected?.kind === "skill"
        ? {
            skills: [{ id: selected.name }],
            text: command?.[2] ?? `Use the ${selected.name} skill.`,
          }
        : {}),
      metadata: {
        ...(options?.clientMessageId ? { paseoClientMessageId: options.clientMessageId } : {}),
        ...(output ? { paseoOutputSchema: output.schema } : {}),
      },
    });
  }
  private promptInput(prompt: AgentPromptInput) {
    if (typeof prompt === "string") return { text: prompt, files: [] };
    const text: string[] = [];
    const files: Array<{ uri: string }> = [];
    for (const part of prompt) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "image")
        files.push({ uri: `data:${part.mimeType};base64,${part.data}` });
      else text.push(renderPromptAttachmentAsText(part));
    }
    return { text: text.join("\n"), files };
  }
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.turn?.id !== options.expectedTurnId || this.stopping) return { status: "unavailable" };
    await this.options.client().session.prompt({
      sessionID: this.options.id,
      ...this.promptInput(prompt),
      delivery: "steer",
      metadata: options.clientMessageId
        ? { paseoClientMessageId: options.clientMessageId }
        : undefined,
    });
    if (options.clearPendingPermissions) await this.options.clearPermissions();
    return { status: "accepted" };
  }
  private async settleInterruptedTurn(turn: Turn | null) {
    await this.reconcile();
    if (!turn) return;
    // OpenCode's session.interrupt forks Fiber.interrupt asynchronously; if SSE is down while
    // cleanup clears /api/session/active, poll promptly for a bounded window before falling back
    // to SSE and the 5s scheduleRecovery timer.
    for (
      let poll = 0;
      poll < INTERRUPT_SETTLE_MAX_POLLS && this.turn === turn && !this.options.signal.aborted;
      poll += 1
    ) {
      const done = await waitForTurnOrPoll(
        turn.completion,
        INTERRUPT_SETTLE_POLL_MS,
        this.options.signal,
      );
      if (done || this.turn !== turn || this.options.signal.aborted) return;
      await this.reconcile();
    }
    if (this.turn === turn && !this.options.signal.aborted) {
      await waitForCompletionOrAbort(turn.completion, this.options.signal);
    }
  }
  async interrupt() {
    if (!this.stopping || this.stopFailed) {
      this.stopFailed = false;
      const turn = this.turn;
      const stop = (async () => {
        // A stop sent before the queued prompt is accepted would interrupt an idle session.
        await turn?.submitted;
        await this.options.client().session.interrupt({ sessionID: this.options.id });
        if (turn && this.turn === turn) {
          turn.interruptRequested = true;
          this.revision += 1;
        }
        await this.settleInterruptedTurn(turn);
      })();
      this.stopping = stop;
      try {
        await stop;
        this.stopping = null;
      } catch (error) {
        this.stopFailed = true;
        throw error;
      }
    } else await this.stopping;
  }
  private observeActiveTurn() {
    if (this.turn || this.options.signal.aborted) return;
    this.createTurn(Promise.resolve(), true);
  }
}
