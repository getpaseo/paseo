import type {
  PiRuntime,
  PiRuntimeLaunch,
  PiRuntimeSession,
  PiStartSessionInput,
} from "../runtime.js";
import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "../rpc-types.js";
import { buildPiLaunch } from "../runtime.js";

type FakePiSubagentSubscriptionLevel = "off" | "progress" | "events";
type FakePiSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface FakePiSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: FakePiSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface FakePiSubagentMessagesSelector {
  subagentId?: string;
  sessionFile?: string;
  fromByte?: number;
}

export interface FakePiSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: PiAgentMessage[];
}

interface FakePiUserEntry {
  id: string;
  parentId: string | null;
  text: string;
}

export class FakePi implements PiRuntime {
  readonly recordedLaunches: PiRuntimeLaunch[] = [];
  private readonly sessions: FakePiSession[] = [];
  private readonly command: [string, ...string[]];
  private readonly queuedCommands: PiRpcSlashCommand[][] = [];
  private readonly queuedSessionSetups: Array<(session: FakePiSession) => void> = [];

  constructor(command: [string, ...string[]] = ["pi"]) {
    this.command = command;
  }

  async startSession(input: PiStartSessionInput): Promise<FakePiSession> {
    const launch = buildPiLaunch({
      command: this.command,
      session: input,
    });
    this.recordedLaunches.push(launch);
    const session = new FakePiSession(launch);
    session.commands = this.queuedCommands.shift() ?? [];
    this.queuedSessionSetups.shift()?.(session);
    this.sessions.push(session);
    return session;
  }

  queueCommands(commands: PiRpcSlashCommand[]): void {
    this.queuedCommands.push(commands);
  }

  queueSessionSetup(setup: (session: FakePiSession) => void): void {
    this.queuedSessionSetups.push(setup);
  }

  latestSession(): FakePiSession {
    const session = this.sessions.at(-1);
    if (!session) {
      throw new Error("FakePi has no sessions");
    }
    return session;
  }
}

export class FakePiSession implements PiRuntimeSession {
  readonly prompts: Array<{ message: string; imageCount: number }> = [];
  readonly compactRequests: Array<{ customInstructions?: string }> = [];
  readonly setAutoCompactionRequests: boolean[] = [];
  readonly subagentSubscriptionRequests: FakePiSubagentSubscriptionLevel[] = [];
  readonly subagentMessageRequests: FakePiSubagentMessagesSelector[] = [];
  readonly setModelRequests: Array<{ provider: string; modelId: string }> = [];
  readonly setThinkingLevelRequests: string[] = [];
  readonly treeNavigationRequests: string[] = [];
  readonly handoffRequests: Array<{ customInstructions?: string }> = [];
  readonly sessionNameRequests: string[] = [];
  readonly rawFrames: Array<object & { type: string }> = [];
  capturedUserEntries: Array<{ id: string; parentId: string | null; text: string }> = [];
  abortRequested = false;
  readonly canceledExtensionUiRequests: string[] = [];
  readonly extensionUiResponses: Array<{
    id: string;
    response: { value?: string; confirmed?: boolean; cancelled?: boolean };
  }> = [];
  setModelResult: PiModel | null = null;
  models: PiModel[] = [];
  messages: PiAgentMessage[] = [];
  stats: PiSessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  commands: PiRpcSlashCommand[] = [];
  subagents: FakePiSubagentSnapshot[] = [];
  subagentSubscriptionError: Error | null = null;
  setSessionNameError: Error | null = null;
  compactError: Error | null = null;
  emitCompactEnd = true;
  getStateError: Error | null = null;
  promptAck: PiPromptAck = {};
  branchResponse: { text?: string; cancelled?: boolean } = { text: "" };
  readonly branchRequests: string[] = [];
  state: PiSessionState;

  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();
  private readonly subagentMessageResults = new Map<string, FakePiSubagentMessagesResult[]>();
  private nextHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null = null;
  private activeHeldPrompt: { promise: Promise<void>; reject: (error: Error) => void } | null =
    null;

  constructor(launch: PiRuntimeLaunch) {
    this.state = {
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      sessionFile: launch.session ?? "/tmp/pi-session",
      sessionId: "pi-session-1",
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck> {
    this.prompts.push({ message, imageCount: images?.length ?? 0 });
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
    this.handleTreeNavigationCommand(message);
    this.handleEntryCaptureCommand(message);
    return this.promptAck;
  }

  holdNextPrompt(): void {
    if (this.nextHeldPrompt || this.activeHeldPrompt) {
      throw new Error("FakePi already has a held prompt");
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
      throw new Error("FakePi has no held prompt");
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

  async getState(): Promise<PiSessionState> {
    if (this.getStateError) {
      throw this.getStateError;
    }
    return this.state;
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    return this.messages;
  }

  async getAvailableModels(_timeoutMs?: number | null): Promise<PiModel[]> {
    return this.models;
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    this.setModelRequests.push({ provider, modelId });
    if (!this.setModelResult) {
      throw new Error("FakePi setModel requires setModelResult to be scripted");
    }
    return this.setModelResult;
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingLevelRequests.push(level);
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return this.stats;
  }

  async setSubagentSubscription(level: FakePiSubagentSubscriptionLevel): Promise<void> {
    this.subagentSubscriptionRequests.push(level);
    if (this.subagentSubscriptionError) {
      throw this.subagentSubscriptionError;
    }
  }

  async getSubagents(): Promise<FakePiSubagentSnapshot[]> {
    return this.subagents;
  }

  async getSubagentMessages(
    selector: FakePiSubagentMessagesSelector,
  ): Promise<FakePiSubagentMessagesResult> {
    this.subagentMessageRequests.push(selector);
    const key = selector.sessionFile ?? selector.subagentId;
    if (!key) {
      throw new Error("FakePi getSubagentMessages requires a selector");
    }
    const results = this.subagentMessageResults.get(key);
    const result = results?.shift();
    if (!result) {
      throw new Error(`FakePi has no subagent messages queued for ${key}`);
    }
    return result;
  }

  queueSubagentMessages(result: FakePiSubagentMessagesResult): void {
    const results = this.subagentMessageResults.get(result.sessionFile) ?? [];
    results.push(result);
    this.subagentMessageResults.set(result.sessionFile, results);
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    return this.commands;
  }

  sendRawFrame(frame: object & { type: string }): void {
    this.rawFrames.push(frame);
  }

  async request(command: { type: string; [key: string]: unknown }): Promise<unknown> {
    switch (command.type) {
      case "set_subagent_subscription":
        await this.setSubagentSubscription(command.level as FakePiSubagentSubscriptionLevel);
        return {};
      case "get_subagents":
        return { subagents: await this.getSubagents() };
      case "get_subagent_messages":
        return await this.getSubagentMessages({
          ...(typeof command.subagentId === "string" ? { subagentId: command.subagentId } : {}),
          ...(typeof command.sessionFile === "string" ? { sessionFile: command.sessionFile } : {}),
          ...(typeof command.fromByte === "number" ? { fromByte: command.fromByte } : {}),
        });
      case "branch": {
        const entryId = typeof command.entryId === "string" ? command.entryId : "";
        this.branchRequests.push(entryId);
        return this.branchResponse;
      }
      case "handoff":
        this.handoffRequests.push(
          typeof command.customInstructions === "string"
            ? { customInstructions: command.customInstructions }
            : {},
        );
        return {};
      case "set_session_name":
        this.sessionNameRequests.push(typeof command.name === "string" ? command.name : "");
        if (this.setSessionNameError) {
          throw this.setSessionNameError;
        }
        return {};
      default:
        throw new Error(`FakePi request does not implement ${command.type}`);
    }
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

  async close(): Promise<void> {}

  emit(event: PiRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  finishTurn(message: PiAgentMessage = { role: "assistant", content: [] }): void {
    this.messages = [...this.messages, message];
    this.emit({ type: "agent_end", messages: this.messages });
  }

  finishSubmittedUserMessage(entry: FakePiUserEntry): void {
    this.emit({
      type: "message_end",
      message: { role: "user", content: entry.text },
    });
    this.emit({
      type: "extension_ui_request",
      id: `submitted-user-${entry.id}`,
      method: "notify",
      message: `PASEO_SUBMITTED_USER_ENTRY ${JSON.stringify({ entry })}`,
    });
  }

  private handleTreeNavigationCommand(message: string): void {
    const prefix = "/paseo_tree ";
    if (!message.startsWith(prefix)) {
      return;
    }
    const payload = JSON.parse(
      Buffer.from(message.slice(prefix.length), "base64url").toString("utf8"),
    ) as { targetId?: unknown; requestId?: unknown };
    if (typeof payload.targetId !== "string" || typeof payload.requestId !== "string") {
      return;
    }
    this.treeNavigationRequests.push(payload.targetId);
    this.emitEntryCapture(undefined, "tree_navigation");
    this.emitExtensionCommandResult(payload.requestId, { ok: true, result: {} });
  }

  private handleEntryCaptureCommand(message: string): void {
    const prefix = "/paseo_capture_entries ";
    if (!message.startsWith(prefix)) {
      return;
    }
    const payload = JSON.parse(
      Buffer.from(message.slice(prefix.length), "base64url").toString("utf8"),
    ) as { requestId?: unknown; reason?: unknown };
    if (typeof payload.requestId !== "string") {
      return;
    }
    this.emitEntryCapture(
      payload.requestId,
      typeof payload.reason === "string" ? payload.reason : "command",
    );
  }

  emitEntryCapture(requestId?: string, reason = "test"): void {
    this.emit({
      type: "extension_ui_request",
      id: `capture-${requestId ?? reason}`,
      method: "notify",
      message: `PASEO_ENTRY_CAPTURE ${JSON.stringify({
        reason,
        requestId,
        entries: this.capturedUserEntries,
      })}`,
    });
  }

  private emitExtensionCommandResult(
    requestId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    this.emit({
      type: "extension_ui_request",
      id: `command-${requestId}`,
      method: "notify",
      message: `PASEO_COMMAND_RESULT ${JSON.stringify({ requestId, ...result })}`,
    });
  }
}
