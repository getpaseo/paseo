import type {
  OmpRuntime,
  OmpRuntimeLaunch,
  OmpRuntimeSession,
  OmpStartSessionInput,
} from "../runtime.js";
import type {
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpAgentMessage,
  OmpModel,
  OmpPromptAck,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpThinkingLevel,
} from "../rpc-types.js";
import { buildOmpLaunch } from "../runtime.js";

type FakeOmpSubagentSubscriptionLevel = "off" | "progress" | "events";
type FakeOmpSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface FakeOmpSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: FakeOmpSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface FakeOmpSubagentMessagesSelector {
  subagentId?: string;
  sessionFile?: string;
  fromByte?: number;
}

export interface FakeOmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: OmpAgentMessage[];
}

export class FakeOmp implements OmpRuntime {
  readonly recordedLaunches: OmpRuntimeLaunch[] = [];
  private readonly sessions: FakeOmpSession[] = [];
  private readonly command: [string, ...string[]];
  private readonly queuedCommands: OmpRpcSlashCommand[][] = [];
  private readonly queuedSubagentSubscriptionErrors = new Map<
    FakeOmpSubagentSubscriptionLevel,
    Error
  >();

  constructor(command: [string, ...string[]] = ["omp"]) {
    this.command = command;
  }

  async startSession(input: OmpStartSessionInput): Promise<FakeOmpSession> {
    const launch = buildOmpLaunch({
      command: this.command,
      session: input,
    });
    this.recordedLaunches.push(launch);
    const session = new FakeOmpSession(launch);
    session.commands = this.queuedCommands.shift() ?? [];
    for (const [level, error] of this.queuedSubagentSubscriptionErrors) {
      session.subagentSubscriptionErrors.set(level, error);
    }
    this.queuedSubagentSubscriptionErrors.clear();
    this.sessions.push(session);
    return session;
  }

  queueCommands(commands: OmpRpcSlashCommand[]): void {
    this.queuedCommands.push(commands);
  }

  failNextSubagentSubscription(level: FakeOmpSubagentSubscriptionLevel, error: Error): void {
    this.queuedSubagentSubscriptionErrors.set(level, error);
  }

  latestSession(): FakeOmpSession {
    const session = this.sessions.at(-1);
    if (!session) {
      throw new Error("FakeOmp has no sessions");
    }
    return session;
  }
}

export class FakeOmpSession implements OmpRuntimeSession {
  readonly prompts: Array<{ message: string; imageCount: number }> = [];
  readonly compactRequests: Array<{ customInstructions?: string }> = [];
  readonly setAutoCompactionRequests: boolean[] = [];
  readonly subagentSubscriptionRequests: FakeOmpSubagentSubscriptionLevel[] = [];
  readonly subagentMessageRequests: FakeOmpSubagentMessagesSelector[] = [];
  readonly setModelRequests: Array<{ provider: string; modelId: string }> = [];
  readonly setThinkingLevelRequests: OmpThinkingLevel[] = [];
  readonly handoffRequests: Array<{ customInstructions?: string }> = [];
  readonly steerRequests: Array<{ message: string; imageCount: number }> = [];
  readonly followUpRequests: Array<{ message: string; imageCount: number }> = [];
  readonly hostToolSetRequests: OmpRpcHostToolDefinition[][] = [];
  readonly hostToolResults: OmpRpcHostToolResult[] = [];
  readonly hostToolUpdates: OmpRpcHostToolUpdate[] = [];
  getStateRequestCount = 0;
  abortRequested = false;
  readonly canceledExtensionUiRequests: string[] = [];
  readonly extensionUiResponses: Array<{
    id: string;
    response: { value?: string; confirmed?: boolean; cancelled?: boolean };
  }> = [];
  setModelResult: OmpModel | null = null;
  models: OmpModel[] = [];
  messages: OmpAgentMessage[] = [];
  stats: OmpSessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  commands: OmpRpcSlashCommand[] = [];
  subagents: FakeOmpSubagentSnapshot[] = [];
  readonly subagentSubscriptionErrors = new Map<FakeOmpSubagentSubscriptionLevel, Error>();
  compactError: Error | null = null;
  emitCompactEnd = true;
  getStateError: Error | null = null;
  promptAck: OmpPromptAck = {};
  branchResponse: { text?: string; cancelled?: boolean } = { text: "" };
  branchMessages: Array<{ entryId: string; text: string }> = [];
  readonly branchRequests: string[] = [];
  activeBranchEntryId?: string;
  closed = false;
  state: OmpSessionState;

  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  private readonly stateReports: OmpSessionState[] = [];
  private readonly stateRequestWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly hostToolResultWaiters: Array<(result: OmpRpcHostToolResult) => void> = [];
  private readonly promptWaiters: Array<() => void> = [];
  private readonly subscriptionWaiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly subagentMessageResults = new Map<string, FakeOmpSubagentMessagesResult[]>();
  private nextHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null = null;
  private activeHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null =
    null;

  constructor(launch: OmpRuntimeLaunch) {
    this.state = {
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      sessionFile: launch.session ?? "/tmp/omp-session",
      sessionId: "omp-session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    };
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck> {
    if (this.state.isStreaming || this.state.isCompacting) {
      throw new Error("Agent is already processing");
    }
    this.prompts.push({ message, imageCount: images?.length ?? 0 });
    this.promptWaiters.shift()?.();
    const heldPrompt = this.nextHeldPrompt;
    if (heldPrompt) {
      this.nextHeldPrompt = null;
      this.activeHeldPrompt = heldPrompt;
      try {
        await heldPrompt.promise;
      } finally {
        if (this.activeHeldPrompt === heldPrompt) {
          this.activeHeldPrompt = null;
        }
      }
    }
    return this.promptAck;
  }

  nextPrompt(): Promise<void> {
    return new Promise((resolve) => this.promptWaiters.push(resolve));
  }

  holdNextPrompt(): void {
    if (this.nextHeldPrompt || this.activeHeldPrompt) {
      throw new Error("FakeOmp already has a held prompt");
    }
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.nextHeldPrompt = { promise, reject };
  }

  async failHeldPrompt(error: Error): Promise<void> {
    const heldPrompt = this.activeHeldPrompt ?? this.nextHeldPrompt;
    if (!heldPrompt) {
      throw new Error("FakeOmp has no held prompt");
    }
    heldPrompt.reject(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async compact(customInstructions?: string): Promise<void> {
    this.compactRequests.push(customInstructions === undefined ? {} : { customInstructions });
    this.emit({ type: "compaction_start", reason: "manual" });
    if (this.emitCompactEnd) {
      this.emit({ type: "compaction_end", reason: "manual" });
    }
    if (this.compactError) {
      throw this.compactError;
    }
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.setAutoCompactionRequests.push(enabled);
    this.state = {
      ...this.state,
      autoCompactionEnabled: enabled,
    };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
  }

  async getState(): Promise<OmpSessionState> {
    this.getStateRequestCount += 1;
    for (const waiter of this.stateRequestWaiters.splice(0)) {
      if (this.getStateRequestCount >= waiter.count) waiter.resolve();
      else this.stateRequestWaiters.push(waiter);
    }
    if (this.getStateError) {
      throw this.getStateError;
    }
    const report = this.stateReports.shift();
    if (report) {
      this.state = report;
    }
    return this.state;
  }

  queueStateReports(states: OmpSessionState[]): void {
    this.stateReports.push(...states);
  }

  waitForStateRequests(count: number): Promise<void> {
    if (this.getStateRequestCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.stateRequestWaiters.push({ count, resolve }));
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    return this.messages;
  }

  async getAvailableModels(_timeoutMs?: number): Promise<OmpModel[]> {
    return this.models;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    this.setModelRequests.push({ provider, modelId });
    if (!this.setModelResult) {
      throw new Error("FakeOmp setModel requires setModelResult to be scripted");
    }
    return this.setModelResult;
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    this.setThinkingLevelRequests.push(level);
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return this.stats;
  }

  async setSubagentSubscription(level: FakeOmpSubagentSubscriptionLevel): Promise<void> {
    this.subagentSubscriptionRequests.push(level);
    for (const waiter of this.subscriptionWaiters.splice(0)) {
      if (this.subagentSubscriptionRequests.length >= waiter.count) waiter.resolve();
      else this.subscriptionWaiters.push(waiter);
    }
    const error = this.subagentSubscriptionErrors.get(level);
    if (error) {
      throw error;
    }
  }

  waitForSubagentSubscriptions(count: number): Promise<void> {
    if (this.subagentSubscriptionRequests.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.subscriptionWaiters.push({ count, resolve }));
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    this.hostToolSetRequests.push(tools);
    return tools.map((tool) => tool.name);
  }

  async branch(entryId: string): Promise<{ text: string }> {
    this.branchRequests.push(entryId);
    if (this.branchResponse.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof this.branchResponse.text !== "string") {
      throw new Error("FakeOmp branch response requires text");
    }
    this.activeBranchEntryId = entryId;
    return { text: this.branchResponse.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.branchMessages;
  }

  steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): void {
    this.steerRequests.push({ message, imageCount: images?.length ?? 0 });
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void {
    this.followUpRequests.push({ message, imageCount: images?.length ?? 0 });
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.hostToolResults.push(result);
    this.hostToolResultWaiters.shift()?.(result);
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.hostToolUpdates.push(update);
  }

  nextHostToolResult(): Promise<OmpRpcHostToolResult> {
    return new Promise((resolve) => this.hostToolResultWaiters.push(resolve));
  }

  async getSubagents(): Promise<FakeOmpSubagentSnapshot[]> {
    return this.subagents;
  }

  async getSubagentMessages(
    selector: FakeOmpSubagentMessagesSelector,
  ): Promise<FakeOmpSubagentMessagesResult> {
    this.subagentMessageRequests.push(selector);
    const key = selector.sessionFile ?? selector.subagentId;
    if (!key) {
      throw new Error("FakeOmp getSubagentMessages requires a selector");
    }
    const results = this.subagentMessageResults.get(key);
    const result = results?.shift();
    if (!result) {
      throw new Error(`FakeOmp has no subagent messages queued for ${key}`);
    }
    return result;
  }

  queueSubagentMessages(result: FakeOmpSubagentMessagesResult): void {
    const results = this.subagentMessageResults.get(result.sessionFile) ?? [];
    results.push(result);
    this.subagentMessageResults.set(result.sessionFile, results);
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    return this.commands;
  }

  async handoff(customInstructions?: string): Promise<void> {
    this.handoffRequests.push(customInstructions ? { customInstructions } : {});
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.extensionUiResponses.push({ id, response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.canceledExtensionUiRequests.push(id);
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  finishTurn(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "agent_end", messages: this.messages });
  }

  finishTurnWithEmptyAgentEnd(message: OmpAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "message_end", message });
    this.emit({ type: "agent_end", messages: [] });
  }

  beginTurn(): void {
    this.emit({ type: "turn_start" });
  }

  acceptPrompt(text: string, entryId = "omp-user-1"): void {
    this.emit({
      type: "message_end",
      message: { role: "user", content: text, entryId } as OmpAgentMessage,
    });
  }

  acceptCustomMessage(content: string): void {
    this.emit({
      type: "message_end",
      message: { role: "custom", content },
    });
  }

  streamAssistantText(text: string, responseId = "omp-assistant-1"): void {
    const message: OmpAgentMessage = {
      role: "assistant",
      content: [],
      responseId,
    };
    this.emit({ type: "message_start", message });
    this.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
  }

  requestToolApproval(input: {
    id: string;
    tool: "bash" | "edit" | "write";
    detail: string;
  }): void {
    let detailLabel = "Path";
    if (input.tool === "bash") {
      detailLabel = "Command";
    } else if (input.tool === "edit") {
      detailLabel = "File";
    }
    this.emit({
      type: "extension_ui_request",
      id: input.id,
      method: "select",
      title: `Allow tool: ${input.tool}\n${detailLabel}: ${input.detail}`,
      options: ["Approve", "Deny"],
    });
  }
}
