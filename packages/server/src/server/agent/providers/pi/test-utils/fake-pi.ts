import type {
  PiRuntime,
  PiRuntimeLaunch,
  PiRuntimeSession,
  PiStartSessionInput,
} from "../runtime.js";
import type {
  PiAgentMessage,
  PiModel,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "../rpc-types.js";
import { buildPiLaunch } from "../runtime.js";

export class FakePi implements PiRuntime {
  readonly recordedLaunches: PiRuntimeLaunch[] = [];
  private readonly sessions: FakePiSession[] = [];
  private readonly command: [string, ...string[]];
  private readonly queuedCommands: PiRpcSlashCommand[][] = [];

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
    this.sessions.push(session);
    return session;
  }

  queueCommands(commands: PiRpcSlashCommand[]): void {
    this.queuedCommands.push(commands);
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
  readonly setModelRequests: Array<{ provider: string; modelId: string }> = [];
  readonly setThinkingLevelRequests: string[] = [];
  readonly treeNavigationRequests: string[] = [];
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
  compactError: Error | null = null;
  emitCompactEnd = true;
  state: PiSessionState;

  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();

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
  ): Promise<void> {
    this.prompts.push({ message, imageCount: images?.length ?? 0 });
    this.handleTreeNavigationCommand(message);
    this.handleEntryCaptureCommand(message);
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
    return this.state;
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    return this.messages;
  }

  async getAvailableModels(): Promise<PiModel[]> {
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

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    return this.commands;
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
