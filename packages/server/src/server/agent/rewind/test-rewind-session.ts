import type {
  AgentCapabilityFlags,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  AgentTimelineItem,
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

export class FakeRewindSession implements AgentSession {
  readonly provider: AgentProvider = "claude";
  readonly id = "fake-rewind-session";
  readonly capabilities = REWIND_TEST_CAPABILITIES;
  readonly recordedRewinds: RecordedRewind[] = [];
  aborted = false;
  historyReadCount = 0;
  history: AgentTimelineItem[] = [{ type: "user_message", text: "before", messageId: "message-1" }];

  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;

  constructor(private readonly waitBeforeHistory?: () => Promise<void>) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.aborted = false;
    this.activeTurnId = "turn-1";
    queueMicrotask(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId: "turn-1" });
    });
    return { turnId: "turn-1" };
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
    return { provider: this.provider, sessionId: this.id };
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

  async revertConversation(input: { messageId: string }): Promise<void> {
    this.recordedRewinds.push({ mode: "conversation", messageId: input.messageId });
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    this.recordedRewinds.push({ mode: "files", messageId: input.messageId });
  }

  async revertBoth(input: { messageId: string }): Promise<void> {
    this.recordedRewinds.push({ mode: "both", messageId: input.messageId });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
