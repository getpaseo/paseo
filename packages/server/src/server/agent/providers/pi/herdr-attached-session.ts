import { randomUUID } from "node:crypto";

import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSlashCommand,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import { runProviderTurn } from "../provider-runner.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import {
  encodeHerdrAttachedPiHandle,
  HERDR_ATTACHED_PI_RUNTIME,
  toPersistedHerdrAttachedPiMetadata,
  validateHerdrAttachedPiTarget,
  type HerdrAttachedPiMetadata,
} from "./herdr-attachment.js";
import type { HerdrAgent, HerdrClient } from "./herdr-client.js";
import {
  mapPiNativeHistoryEvents,
  readPiNativeHistory,
  selectPiNativeHistoryEventsAfter,
  type PiNativeHistoryEvent,
} from "./native-history.js";

const PI_PROVIDER = "pi";
const DEFAULT_POLL_INTERVAL_MS = 1_000;

class HerdrAttachmentIdentityError extends Error {}

const HERDR_ATTACHED_PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

interface HerdrAttachedPiSessionOptions {
  herdrClient: HerdrClient;
  metadata: HerdrAttachedPiMetadata;
  config: { cwd: string; model?: string; thinkingOptionId?: string; modeId?: string };
  pollIntervalMs?: number;
}

interface ActiveTurn {
  turnId: string;
  promptText: string;
  clientMessageId: string | null;
  baselineNativeEntryId: string | null;
  submittedNativeEntryId: string | null;
  observedNativeEntry: boolean;
}

export class HerdrAttachedPiSession implements AgentSession {
  readonly provider: AgentProvider = PI_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = HERDR_ATTACHED_PI_CAPABILITIES;
  readonly features?: AgentFeature[];

  private readonly herdrClient: HerdrClient;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly config: HerdrAttachedPiSessionOptions["config"];
  private metadata: HerdrAttachedPiMetadata;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private closed = false;
  private activeTurn: ActiveTurn | null = null;
  private externalTurnId: string | null = null;
  private offlineError: string | null = null;
  private readonly persistenceCursorByEvent = new WeakMap<AgentStreamEvent, string | null>();

  constructor(options: HerdrAttachedPiSessionOptions) {
    this.herdrClient = options.herdrClient;
    this.metadata = toPersistedHerdrAttachedPiMetadata(options.metadata);
    this.config = options.config;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  get id(): string | null {
    return this.metadata.nativeSessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.metadata.nativeSessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurn) {
      throw new Error("A Herdr-attached Pi turn is already active");
    }
    const target = await this.verifyTarget();
    this.offlineError = null;
    if (isBlockedStatus(target.status)) {
      throw new Error(`Herdr target ${this.metadata.herdrTarget} is blocked`);
    }
    if (this.externalTurnId || isRunningStatus(target.status)) {
      throw new Error(`Herdr target ${this.metadata.herdrTarget} is already running`);
    }

    const promptText = renderHerdrPrompt(prompt);
    const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
    this.assertNativeHistoryMatches(history);
    const turnId = randomUUID();
    this.activeTurn = {
      turnId,
      promptText,
      clientMessageId: options?.clientMessageId ?? null,
      baselineNativeEntryId: history.latestEntryId,
      submittedNativeEntryId: null,
      observedNativeEntry: false,
    };

    try {
      await this.herdrClient.prompt(this.metadata.herdrTarget, promptText);
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    if (this.subscribers.size > 0) {
      this.clearPollTimer();
      this.schedulePoll(0);
    }
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    this.schedulePoll(this.pollIntervalMs);
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.clearPollTimer();
      }
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    await this.verifyTarget();
    const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
    this.assertNativeHistoryMatches(history);
    const events = selectPiNativeHistoryEventsAfter(
      mapPiNativeHistoryEvents(history, this.provider),
      this.metadata.lastSyncedNativeEntryId,
    );
    this.rememberLastSyncedEntry(events);
    for (const { event } of events) {
      yield event;
    }
  }

  async reconcileHistory(): Promise<void> {
    if (this.closed || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const target = await this.verifyTarget();
      this.reconcileHerdrStatus(target);
      const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
      this.assertNativeHistoryMatches(history);
      const events = selectPiNativeHistoryEventsAfter(
        mapPiNativeHistoryEvents(history, this.provider),
        this.metadata.lastSyncedNativeEntryId,
      );
      const afterTurnBaseline = this.nativeEntryIdsAfterTurnBaseline(history.entries);
      this.emitNativeEvents(events, afterTurnBaseline);
      this.observeNativeProgressAfterSubmittedEntry(history.entries);
      this.rememberLastSyncedEntry(events);
      this.completeActiveTurnIfIdle(target.status);
      this.completeExternalTurnIfIdle(target.status);
      this.offlineError = null;
    } catch (error) {
      if (error instanceof HerdrAttachmentIdentityError) {
        this.markOffline(error);
      } else {
        this.offlineError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.pollInFlight = false;
      if (!this.closed && this.subscribers.size > 0) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const target = await this.verifyTarget();
    return {
      provider: this.provider,
      sessionId: this.metadata.nativeSessionId,
      model: this.config.model ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
      modeId: this.config.modeId ?? null,
      extra: {
        runtime: HERDR_ATTACHED_PI_RUNTIME,
        herdrSession: this.metadata.herdrSession,
        herdrTarget: this.metadata.herdrTarget,
        herdrStatus: target.status,
        nativeSessionFile: this.metadata.nativeSessionFile,
      },
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(_modeId: string): Promise<void | AgentProviderNotice> {
    throw new Error("Herdr-attached Pi sessions do not support mode changes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    throw new Error("Herdr-attached Pi sessions do not expose permissions in Paseo");
  }

  describePersistence(event?: AgentStreamEvent): AgentPersistenceHandle | null {
    const metadata = toPersistedHerdrAttachedPiMetadata(this.metadata);
    if (event && this.persistenceCursorByEvent.has(event)) {
      const eventCursor = this.persistenceCursorByEvent.get(event);
      if (eventCursor) {
        metadata.lastSyncedNativeEntryId = eventCursor;
      } else {
        delete metadata.lastSyncedNativeEntryId;
      }
    }
    return {
      provider: this.provider,
      sessionId: encodeHerdrAttachedPiHandle(metadata),
      nativeHandle: this.metadata.nativeSessionFile,
      metadata,
    };
  }

  async interrupt(): Promise<void> {
    await this.verifyTarget();
    await this.herdrClient.interrupt(this.metadata.herdrTarget);
    const turnId = this.activeTurn?.turnId ?? this.externalTurnId;
    this.activeTurn = null;
    this.externalTurnId = null;
    if (turnId) {
      this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearPollTimer();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  async setModel(_modelId: string | null): Promise<void> {
    throw new Error("Herdr-attached Pi sessions do not support model changes from Paseo");
  }

  async setThinkingOption(_thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    throw new Error("Herdr-attached Pi sessions do not support thinking changes from Paseo");
  }

  private async verifyTarget(): Promise<HerdrAgent> {
    const target = await this.herdrClient.getAgent(this.metadata.herdrTarget);
    const validation = validateHerdrAttachedPiTarget(this.metadata, target);
    if (!validation.ok) {
      throw new HerdrAttachmentIdentityError(validation.reason);
    }
    return target;
  }

  private assertNativeHistoryMatches(history: {
    sessionId: string;
    cwd: string;
    sessionFile: string;
  }): void {
    if (history.sessionId !== this.metadata.nativeSessionId) {
      throw new HerdrAttachmentIdentityError(
        `Native Pi session changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
    if (history.sessionFile !== this.metadata.nativeSessionFile) {
      throw new HerdrAttachmentIdentityError(
        `Native Pi session file changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
    if (history.cwd !== this.metadata.cwd) {
      throw new HerdrAttachmentIdentityError(
        `Working directory changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
  }

  private reconcileHerdrStatus(target: HerdrAgent): void {
    if (isBlockedStatus(target.status)) {
      throw new HerdrAttachmentIdentityError(
        `Herdr target ${this.metadata.herdrTarget} is blocked`,
      );
    }
    if (!this.activeTurn && !this.externalTurnId && isRunningStatus(target.status)) {
      this.externalTurnId = randomUUID();
      this.emit({ type: "turn_started", provider: this.provider, turnId: this.externalTurnId });
    }
  }

  private emitNativeEvents(
    events: readonly PiNativeHistoryEvent[],
    afterTurnBaseline: ReadonlySet<string> | null,
  ): void {
    let committedCursor = this.metadata.lastSyncedNativeEntryId ?? null;
    for (const [index, nativeEvent] of events.entries()) {
      const event = this.correlateActiveUserMessage(
        nativeEvent,
        afterTurnBaseline?.has(nativeEvent.entryId) ?? true,
      );
      const completesEntry = events[index + 1]?.entryId !== nativeEvent.entryId;
      const eventCursor = completesEntry ? nativeEvent.entryId : committedCursor;
      this.persistenceCursorByEvent.set(event, eventCursor);
      this.emit(event);
      if (completesEntry) {
        committedCursor = nativeEvent.entryId;
      }
      if (
        this.activeTurn?.submittedNativeEntryId &&
        nativeEvent.entryId !== this.activeTurn.submittedNativeEntryId
      ) {
        this.activeTurn.observedNativeEntry = true;
      }
    }
  }

  private nativeEntryIdsAfterTurnBaseline(
    entries: readonly { entryId: string }[],
  ): ReadonlySet<string> | null {
    const baseline = this.activeTurn?.baselineNativeEntryId;
    if (!this.activeTurn) {
      return null;
    }
    if (!baseline) {
      return new Set(entries.map((entry) => entry.entryId));
    }
    const baselineIndex = entries.findIndex((entry) => entry.entryId === baseline);
    if (baselineIndex === -1) {
      throw new Error(`Native Pi history no longer contains turn baseline ${baseline}`);
    }
    return new Set(entries.slice(baselineIndex + 1).map((entry) => entry.entryId));
  }

  private observeNativeProgressAfterSubmittedEntry(entries: readonly { entryId: string }[]): void {
    const active = this.activeTurn;
    if (!active?.submittedNativeEntryId) {
      return;
    }
    const submittedIndex = entries.findIndex(
      (entry) => entry.entryId === active.submittedNativeEntryId,
    );
    if (submittedIndex >= 0 && submittedIndex < entries.length - 1) {
      active.observedNativeEntry = true;
    }
  }

  private correlateActiveUserMessage(
    nativeEvent: PiNativeHistoryEvent,
    afterTurnBaseline: boolean,
  ): AgentStreamEvent {
    const active = this.activeTurn;
    if (
      !active ||
      !afterTurnBaseline ||
      nativeEvent.event.type !== "timeline" ||
      nativeEvent.event.item.type !== "user_message" ||
      nativeEvent.event.item.clientMessageId ||
      nativeEvent.event.item.text !== active.promptText
    ) {
      return nativeEvent.event;
    }
    active.submittedNativeEntryId = nativeEvent.entryId;
    if (!active.clientMessageId) {
      return nativeEvent.event;
    }
    return {
      ...nativeEvent.event,
      turnId: active.turnId,
      item: {
        ...nativeEvent.event.item,
        clientMessageId: active.clientMessageId,
      },
    };
  }

  private rememberLastSyncedEntry(events: readonly PiNativeHistoryEvent[]): void {
    const latest = events.at(-1)?.entryId;
    if (latest) {
      this.metadata = { ...this.metadata, lastSyncedNativeEntryId: latest };
    }
  }

  private completeActiveTurnIfIdle(status: string | null): void {
    if (!this.activeTurn || !this.activeTurn.observedNativeEntry || !isIdleStatus(status)) {
      return;
    }
    const { turnId } = this.activeTurn;
    this.activeTurn = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  private completeExternalTurnIfIdle(status: string | null): void {
    if (!this.externalTurnId || !isIdleStatus(status)) {
      return;
    }
    const turnId = this.externalTurnId;
    this.externalTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  private markOffline(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.offlineError === message) {
      return;
    }
    this.offlineError = message;
    const turnId = this.activeTurn?.turnId ?? this.externalTurnId ?? undefined;
    this.activeTurn = null;
    this.externalTurnId = null;
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      error: message,
      ...(turnId ? { turnId } : {}),
    });
  }

  private schedulePoll(delayMs: number): void {
    if (this.closed || this.pollTimer) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.reconcileHistory();
    }, delayMs);
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

function renderHerdrPrompt(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "image") {
        return "[Image attachment omitted: Herdr-attached Pi prompt injection supports text only]";
      }
      return renderPromptAttachmentAsText(block);
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function isRunningStatus(status: string | null): boolean {
  return /running|working|busy|streaming|initializing/i.test(status ?? "");
}

function isIdleStatus(status: string | null): boolean {
  return /idle|done|complete|completed|finished/i.test(status ?? "");
}

function isBlockedStatus(status: string | null): boolean {
  return /blocked|permission|attention|waiting/i.test(status ?? "");
}
