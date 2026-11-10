import {
  RewindNotAppliedError,
  type AgentCapabilityFlags,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type ConversationRewindCut,
  type ConversationRewindResult,
} from "../agent-sdk-types.js";

export const REWIND_TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

export interface RecordedRewind {
  mode: "conversation" | "files" | "both";
  messageId: string;
}

/** What the next conversation rewind does to the provider history, and what it reports. */
export type FakeRewindOutcome =
  | { kind: "applied"; cut?: ConversationRewindCut }
  | { kind: "not_applied"; message: string }
  /** The call fails; `applied` says whether the history changed anyway. */
  | { kind: "unknown"; applied: boolean; cut?: ConversationRewindCut }
  /** The call finishes without saying what it removed, as a plugin provider's does. */
  | { kind: "unreported"; applied: boolean };

export class FakeRewindSession implements AgentSession {
  readonly provider: AgentProvider = "claude";
  readonly id = "fake-rewind-session";
  /** The session a resume continues. A rewind that changes it is a provider forking the thread. */
  persistedSessionId = "fake-rewind-session";
  /** Set to make an applied rewind continue in a new provider session, as Claude's fork does. */
  sessionIdAfterRewind: string | null = null;
  readonly capabilities = REWIND_TEST_CAPABILITIES;
  readonly recordedRewinds: RecordedRewind[] = [];
  aborted = false;
  historyReadCount = 0;
  history: AgentTimelineItem[] = [{ type: "user_message", text: "before", messageId: "message-1" }];
  /** Leaves started turns running until interrupted, instead of answering them. */
  holdTurns = true;
  nextRewind: FakeRewindOutcome = { kind: "applied" };
  /** Prompts whose turn spawns a provider subagent through a tool call. */
  readonly subagentPrompts = new Set<string>();
  private promptCount = 0;

  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;

  constructor(private readonly waitBeforeHistory?: () => Promise<void>) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.aborted = false;
    if (this.holdTurns) {
      this.activeTurnId = "turn-1";
      queueMicrotask(() => {
        this.emit({ type: "turn_started", provider: this.provider, turnId: "turn-1" });
      });
      return { turnId: "turn-1" };
    }
    this.promptCount += 1;
    const turnId = `turn-${this.promptCount}`;
    const text = typeof prompt === "string" ? prompt : "prompt";
    const items: AgentTimelineItem[] = [
      {
        type: "user_message",
        text,
        messageId: `provider-${this.promptCount}`,
        ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      },
      { type: "assistant_message", text: `reply to ${text}` },
    ];
    const spawnsSubagent = this.subagentPrompts.has(text);
    const callId = `call-${this.promptCount}`;
    if (spawnsSubagent) {
      items.push({
        type: "tool_call",
        callId,
        name: "Task",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      });
    }
    this.activeTurnId = turnId;
    queueMicrotask(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      for (const item of items) {
        this.history.push(item);
        this.emit({ type: "timeline", provider: this.provider, item, turnId });
      }
      if (spawnsSubagent) {
        this.emit({
          type: "provider_subagent",
          provider: this.provider,
          event: { type: "upsert", id: `child-of-${text}`, toolCallId: callId, status: "running" },
        });
      }
      this.activeTurnId = null;
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
    });
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    this.historyReadCount += 1;
    await this.waitBeforeHistory?.();
    for (const item of this.history) {
      yield { type: "timeline", provider: this.provider, item };
    }
  }

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.persistedSessionId };
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
    if (this.activeTurnId) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
    }
  }

  async close(): Promise<void> {}

  async revertConversation(input: { messageId: string }): Promise<ConversationRewindResult> {
    this.recordedRewinds.push({ mode: "conversation", messageId: input.messageId });
    return this.applyRewind(input.messageId);
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    this.recordedRewinds.push({ mode: "files", messageId: input.messageId });
  }

  async revertBoth(input: { messageId: string }): Promise<ConversationRewindResult> {
    this.recordedRewinds.push({ mode: "both", messageId: input.messageId });
    return this.applyRewind(input.messageId);
  }

  private applyRewind(messageId: string): ConversationRewindResult {
    const outcome = this.nextRewind;
    this.nextRewind = { kind: "applied" };
    if (outcome.kind === "not_applied") throw new RewindNotAppliedError(outcome.message);
    const cut = (outcome.kind !== "unreported" && outcome.cut) || { kind: "at_target" };
    if (outcome.kind === "applied" || outcome.applied) {
      this.cutHistory(messageId, cut);
      if (this.sessionIdAfterRewind) this.persistedSessionId = this.sessionIdAfterRewind;
    }
    if (outcome.kind === "unknown") throw new Error("connection lost during rewind");
    return outcome.kind === "unreported" ? { kind: "unreported" } : cut;
  }

  private cutHistory(messageId: string, cut: ConversationRewindCut): void {
    const promptIndex = (id: string) =>
      this.history.findIndex((item) => item.type === "user_message" && item.messageId === id);
    let keep: number;
    if (cut.kind === "at_target") keep = promptIndex(messageId);
    else if (cut.retainedMessageId === null) keep = 0;
    else {
      const retained = promptIndex(cut.retainedMessageId);
      const next = this.history.findIndex(
        (item, index) => index > retained && item.type === "user_message",
      );
      keep = next < 0 ? this.history.length : next;
    }
    this.history.length = keep;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
