import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentProvider,
  AgentProviderNotice,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentUsage,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../agent-sdk-types.js";
import { runProviderTurn } from "../provider-runner.js";
import {
  MUSE_DEFAULT_THINKING_OPTION_ID,
  MUSE_MODES,
  MUSE_PROVIDER,
  normalizeMuseThinkingOption,
  readSessionRecord,
  resolveMuseApprovalMode,
} from "./agent.js";
import { MuseNotificationFold } from "./fold.js";
import {
  extractMuseHistoryItems,
  mapMuseHistoryItem,
  pageMuseHistoryEvents,
} from "./history.js";
import type { MuseHostConnection, MuseHostExit, MuseHostNotification } from "./host.js";
import type { MuseViewItem } from "./items.js";
import {
  buildMuseApprovalDecision,
  buildMuseUserInputResolution,
  mapMuseApprovalRequest,
  mapMuseUserInputRequest,
  readMspErrorKind,
  type MusePendingRequest,
} from "./permissions.js";
import { convertMusePromptInput } from "./prompts.js";
import { mapMuseMcpServers } from "./mcps.js";
import { resolveMuseRewindCutPoint } from "./rewind.js";
import { composeSystemPromptParts } from "../../system-prompt.js";

const DEFAULT_MUSE_INTERRUPT_TIMEOUT_MS = 30_000;

interface MuseActiveTurn {
  turnId: string;
  commandId: string;
  clientMessageId: string | null;
}

export interface MuseAgentSessionOptions {
  host: MuseHostConnection;
  sessionId: string;
  config: AgentSessionConfig;
  capabilities: AgentCapabilityFlags;
  modelId: string | null;
  modeId: string;
  thinkingOptionId?: string | null;
  /** Delivered with the first turn of a fresh session; never on resume. */
  systemPrefix?: string;
  logger: Logger;
  interruptTimeoutMs?: number;
}

export class MuseAgentSession implements AgentSession {
  readonly provider: AgentProvider = MUSE_PROVIDER;
  readonly capabilities: AgentCapabilityFlags;

  private readonly host: MuseHostConnection;
  private sessionId: string;
  private readonly config: AgentSessionConfig;
  private readonly logger: Logger;
  private readonly interruptTimeoutMs: number;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly fold: MuseNotificationFold;
  private readonly turnWaiters = new Map<string, () => void>();
  private readonly pendingRequests = new Map<string, MusePendingRequest>();
  private activeTurn: MuseActiveTurn | null = null;
  private modelId: string | null;
  private readonly initialModelId: string | null;
  private modeId: string;
  private thinkingOptionId: string | null;
  private systemPrefix: string | undefined;
  private lastUsage: AgentUsage = {};
  private closed = false;

  constructor(options: MuseAgentSessionOptions) {
    this.host = options.host;
    this.sessionId = options.sessionId;
    this.config = options.config;
    this.capabilities = options.capabilities;
    this.modelId = options.modelId;
    this.initialModelId = options.modelId;
    this.modeId = options.modeId;
    this.thinkingOptionId = options.thinkingOptionId ?? null;
    this.systemPrefix = options.systemPrefix;
    this.logger = options.logger;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_MUSE_INTERRUPT_TIMEOUT_MS;
    this.fold = new MuseNotificationFold(this.provider, {
      onEvent: (event) => this.handleFoldEvent(event),
      resolveEchoClientMessageId: (item) => this.resolveEchoClientMessageId(item),
      onUsagePartial: (usage) => {
        this.lastUsage = { ...this.lastUsage, ...usage };
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          usage: this.lastUsage,
          ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
        });
      },
      onDebug: (message, data) => {
        this.logger.debug(data ?? {}, `Muse fold: ${message}`);
      },
    });
    this.host.onNotification((notification) => this.handleNotification(notification));
    this.host.onServerRequest(async (request) => this.handleServerRequest(request));
    this.host.onExit((exit) => this.handleHostExit(exit));
  }

  get id(): string | null {
    return this.sessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Muse session is closed");
    }
    if (this.activeTurn) {
      throw new Error("A Muse turn is already active");
    }
    const systemPrefix = this.systemPrefix;
    this.systemPrefix = undefined;
    const payload = convertMusePromptInput(prompt, { systemPrefix });
    const ack = (await this.host.command("turn/start", {
      sessionId: this.sessionId,
      input: payload.parts,
      displayText: payload.displayText,
      ifBusy: "queue",
    })) as unknown as Record<string, unknown>;
    if (ack["status"] !== "accepted" || typeof ack["turnId"] !== "string") {
      throw new Error("Muse turn was not admitted");
    }
    this.activeTurn = {
      turnId: ack["turnId"],
      commandId: typeof ack["commandId"] === "string" ? ack["commandId"] : ack["turnId"],
      clientMessageId: options?.clientMessageId ?? null,
    };
    return { turnId: ack["turnId"] };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const resumed = (await this.host.command("session/resume", {
      sessionId: this.sessionId,
    })) as unknown as Record<string, unknown>;
    const history = (resumed as { history?: unknown }).history;
    const items = extractMuseHistoryItems(history);
    if (items) {
      for (const item of items) {
        const event = mapMuseHistoryItem(item, this.provider);
        if (event) {
          yield event;
        }
      }
      return;
    }
    yield* await this.pageHistory();
  }

  private async *pageHistory(): AsyncGenerator<AgentStreamEvent> {
    const events = await pageMuseHistoryEvents(
      this.host,
      this.sessionId,
      this.provider,
      (message, data) => this.logger.debug(data ?? {}, `Muse history: ${message}`),
    );
    yield* events;
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.modelId,
      thinkingOptionId: this.thinkingOptionId,
      modeId: this.modeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MUSE_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.modeId;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    const approvalMode = resolveMuseApprovalMode(modeId);
    await this.host.command("session/setApprovalMode", {
      sessionId: this.sessionId,
      approvalMode,
    });
    this.modeId = approvalMode;
    this.emit({
      type: "mode_changed",
      provider: this.provider,
      currentModeId: this.modeId,
      availableModes: MUSE_MODES,
    });
  }

  async setModel(modelId: string | null): Promise<void> {
    const target = modelId ?? this.initialModelId;
    if (!target) {
      return;
    }
    await this.host.command("session/setModel", {
      sessionId: this.sessionId,
      model: { modelId: target },
    });
    this.modelId = target;
    this.emit({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: await this.getRuntimeInfo(),
    });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const effort = normalizeMuseThinkingOption(thinkingOptionId) ?? MUSE_DEFAULT_THINKING_OPTION_ID;
    await this.host.command("session/setReasoningEffort", {
      sessionId: this.sessionId,
      reasoningEffort: effort,
    });
    this.thinkingOptionId = effort;
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    const active = this.activeTurn;
    if (!active || active.turnId !== options.expectedTurnId) {
      return { status: "unavailable" };
    }
    const payload = convertMusePromptInput(prompt);
    try {
      await this.host.command("turn/steer", {
        sessionId: this.sessionId,
        expectedTurnId: active.turnId,
        input: payload.parts,
      });
    } catch (error) {
      if (readMspErrorKind(error) === "commandRejected") {
        return { status: "unavailable" };
      }
      throw error;
    }
    return { status: "accepted" };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingRequests.values()].map((entry) => entry.request);
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const entry = this.pendingRequests.get(requestId);
    if (!entry) {
      throw new Error(`Unknown Muse permission request: ${requestId}`);
    }
    if (entry.kind === "approval") {
      await this.decideApproval(entry, response);
    } else {
      await this.answerUserInput(entry, response);
    }
    this.pendingRequests.delete(requestId);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
    });
  }

  private async decideApproval(
    entry: Extract<MusePendingRequest, { kind: "approval" }>,
    response: AgentPermissionResponse,
  ): Promise<void> {
    try {
      await this.sendApprovalDecision(entry, buildMuseApprovalDecision(entry, response));
      return;
    } catch (error) {
      const kind = readMspErrorKind(error);
      if (kind === "approvalAlreadyResolved") {
        return;
      }
      if (kind === "approvalNotFound") {
        this.pendingRequests.delete(entry.approvalId);
        throw new Error("Muse approval is no longer pending", { cause: error });
      }
      if (kind === "approvalRequirementStale") {
        const refreshed = await this.refreshPendingApproval(entry.approvalId);
        if (!refreshed) {
          this.pendingRequests.delete(entry.approvalId);
          throw error;
        }
        await this.sendApprovalDecision(refreshed, buildMuseApprovalDecision(refreshed, response));
        return;
      }
      if (kind === "approvalChoiceInvalid") {
        await this.refreshPendingApproval(entry.approvalId);
        throw new Error("Muse approval choices changed; review the updated request", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async sendApprovalDecision(
    entry: Extract<MusePendingRequest, { kind: "approval" }>,
    decision: { choiceId: string; feedback?: string },
  ): Promise<void> {
    await this.host.command("approval/decide", {
      sessionId: entry.sessionId,
      approvalId: entry.approvalId,
      requirementId: entry.requirementId,
      choiceId: decision.choiceId,
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
    });
  }

  private async refreshPendingApproval(
    approvalId: string,
  ): Promise<Extract<MusePendingRequest, { kind: "approval" }> | null> {
    const result = (await this.host.command("approval/listPending", {
      sessionId: this.sessionId,
    })) as unknown as Record<string, unknown>;
    const approvals = Array.isArray(result["approvals"]) ? result["approvals"] : [];
    for (const params of approvals) {
      if (typeof params !== "object" || params === null) {
        continue;
      }
      const mapped = mapMuseApprovalRequest(params as Record<string, unknown>, this.provider);
      if (mapped && mapped.entry.approvalId === approvalId) {
        this.pendingRequests.set(approvalId, mapped.entry);
        return mapped.entry;
      }
    }
    return null;
  }

  private async answerUserInput(
    entry: Extract<MusePendingRequest, { kind: "userInput" }>,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const resolution = buildMuseUserInputResolution(entry, response);
    try {
      if (resolution.cancel) {
        await this.host.command("userInput/cancel", {
          sessionId: entry.sessionId,
          userInputId: entry.userInputId,
          ...(resolution.reason ? { reason: resolution.reason } : {}),
        });
        return;
      }
      await this.host.command("userInput/answer", {
        sessionId: entry.sessionId,
        userInputId: entry.userInputId,
        answers: resolution.answers,
      });
    } catch (error) {
      const kind = readMspErrorKind(error);
      if (kind === "userInputAlreadySettled") {
        return;
      }
      if (kind === "userInputNotFound") {
        this.pendingRequests.delete(entry.userInputId);
        throw new Error("Muse question is no longer pending", { cause: error });
      }
      throw error;
    }
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      nativeHandle: this.sessionId,
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.modeId ? { modeId: this.modeId } : {}),
        ...(this.thinkingOptionId ? { thinkingOptionId: this.thinkingOptionId } : {}),
      },
    };
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    if (this.closed) {
      throw new Error("Muse session is closed");
    }
    if (this.activeTurn) {
      throw new Error("Cannot rewind the Muse conversation while a turn is active");
    }
    const plan = resolveMuseRewindCutPoint(await this.readRewindItems(), input.messageId);
    if (plan.kind === "fresh") {
      await this.startFreshSessionForRewind();
      return;
    }
    let forked: unknown;
    try {
      forked = await this.host.command("session/fork", {
        sessionId: this.sessionId,
        cutPoint: { lastTurnId: plan.lastTurnId },
        excludeItems: true,
      });
    } catch (error) {
      if (readMspErrorKind(error) === "forkBoundaryInvalid") {
        throw new Error(
          `Muse rewind target turn ${plan.lastTurnId} is not a completed-turn boundary`,
          { cause: error },
        );
      }
      throw error;
    }
    const session = readSessionRecord(forked as Record<string, unknown>);
    if (!session.sessionId) {
      throw new Error("Muse session/fork did not return a session id");
    }
    this.modelId = session.modelId ?? this.modelId;
    this.modeId = session.approvalMode ?? this.modeId;
    this.rebindSession(session.sessionId);
  }

  private async readRewindItems(): Promise<MuseViewItem[]> {
    const result = (await this.host.command("session/read", {
      sessionId: this.sessionId,
      excludeItems: false,
    })) as unknown as Record<string, unknown>;
    const items = extractMuseHistoryItems(result["history"]);
    if (!items) {
      throw new Error("Muse history is not available for rewind");
    }
    return items;
  }

  private async startFreshSessionForRewind(): Promise<void> {
    const approvalMode = resolveMuseApprovalMode(this.modeId);
    const mcpServers = mapMuseMcpServers(this.config.mcpServers, this.logger);
    const started = (await this.host.command("session/start", {
      workspaceRoot: this.config.cwd,
      approvalMode,
      ...(this.modelId ? { modelId: this.modelId } : {}),
      ...(mcpServers ? { config: { mcpServers } } : {}),
    })) as unknown as Record<string, unknown>;
    const session = readSessionRecord(started);
    if (!session.sessionId) {
      throw new Error("Muse session/start did not return a session id");
    }
    if (this.thinkingOptionId) {
      await this.host.command("session/setReasoningEffort", {
        sessionId: session.sessionId,
        reasoningEffort: this.thinkingOptionId,
      });
    }
    this.modelId = session.modelId ?? this.modelId;
    this.modeId = session.approvalMode ?? approvalMode;
    this.systemPrefix = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    this.rebindSession(session.sessionId);
  }

  private rebindSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.pendingRequests.clear();
    this.fold.reset();
    this.lastUsage = {};
  }

  async interrupt(): Promise<void> {
    const active = this.activeTurn;
    if (!active) {
      return;
    }
    try {
      await this.host.command("turn/cancel", {
        sessionId: this.sessionId,
        turnId: active.turnId,
      });
    } catch (error) {
      if (!isMissingRunError(error)) {
        throw error;
      }
    }
    await this.waitForTurnClear(active.turnId);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.activeTurn = null;
    for (const resolve of this.turnWaiters.values()) {
      resolve();
    }
    this.turnWaiters.clear();
    await this.host.close();
  }

  private handleNotification(notification: MuseHostNotification): void {
    if (this.closed) {
      return;
    }
    if (notification.method === "session/modelChanged") {
      const modelId = readModelId(notification.params);
      if (modelId) {
        this.modelId = modelId;
        this.emit({
          type: "model_changed",
          provider: this.provider,
          runtimeInfo: {
            provider: this.provider,
            sessionId: this.sessionId,
            model: this.modelId,
            thinkingOptionId: this.thinkingOptionId,
            modeId: this.modeId,
          },
        });
      }
      return;
    }
    if (notification.method === "approval/resolved") {
      const approvalId = notification.params["approvalId"];
      if (typeof approvalId === "string") {
        this.pendingRequests.delete(approvalId);
      }
      return;
    }
    if (notification.method === "userInput/settled") {
      const userInputId = notification.params["userInputId"];
      if (typeof userInputId === "string") {
        this.pendingRequests.delete(userInputId);
      }
      return;
    }
    if (notification.method === "session/approvalModeChanged") {
      const mode = readApprovalMode(notification.params);
      if (mode) {
        this.modeId = mode;
        this.emit({
          type: "mode_changed",
          provider: this.provider,
          currentModeId: this.modeId,
          availableModes: MUSE_MODES,
        });
      }
      return;
    }
    this.fold.apply(notification);
  }

  private handleFoldEvent(event: AgentStreamEvent): void {
    if (
      (event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled") &&
      event.turnId !== undefined &&
      event.turnId === this.activeTurn?.turnId
    ) {
      this.activeTurn = null;
      const resolve = this.turnWaiters.get(event.turnId);
      if (resolve) {
        this.turnWaiters.delete(event.turnId);
        resolve();
      }
    }
    this.emit(event);
  }

  private async handleServerRequest(request: {
    requestId: string | number;
    method: string;
    params: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (request.method === "approval/request") {
      const mapped = mapMuseApprovalRequest(request.params, this.provider);
      if (!mapped) {
        this.logger.error(
          { requestId: request.requestId },
          "Dropping unparseable Muse approval request",
        );
        return {};
      }
      this.pendingRequests.set(mapped.entry.approvalId, mapped.entry);
      this.emit({
        type: "permission_requested",
        provider: this.provider,
        request: mapped.request,
        ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
      });
      return {};
    }
    if (request.method === "userInput/request") {
      const mapped = mapMuseUserInputRequest(request.params, this.provider);
      if (!mapped) {
        this.logger.error(
          { requestId: request.requestId },
          "Dropping unparseable Muse user-input request",
        );
        return {};
      }
      this.pendingRequests.set(mapped.entry.userInputId, mapped.entry);
      this.emit({
        type: "permission_requested",
        provider: this.provider,
        request: mapped.request,
        ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
      });
      return {};
    }
    this.logger.debug(
      { requestId: request.requestId, method: request.method },
      "Ignoring unknown Muse server request",
    );
    return {};
  }

  private handleHostExit(exit: MuseHostExit): void {
    if (this.closed) {
      return;
    }
    this.logger.error(
      { code: exit.code, signal: exit.signal },
      "Muse host exited unexpectedly",
    );
    const active = this.activeTurn;
    this.activeTurn = null;
    if (!active) {
      return;
    }
    const resolve = this.turnWaiters.get(active.turnId);
    if (resolve) {
      this.turnWaiters.delete(active.turnId);
      resolve();
    }
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      turnId: active.turnId,
      error: `Muse host exited (code ${exit.code ?? "unknown"}) before the turn finished`,
    });
  }

  private resolveEchoClientMessageId(item: MuseViewItem): string | null {
    if (this.activeTurn && item.commandId === this.activeTurn.commandId) {
      return this.activeTurn.clientMessageId;
    }
    return null;
  }

  private async waitForTurnClear(turnId: string): Promise<void> {
    if (this.activeTurn?.turnId !== turnId) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(
          new Error(`Timed out waiting for Muse turn ${turnId} to settle after cancel`),
        );
      }, this.interruptTimeoutMs);
      this.turnWaiters.set(turnId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

function readModelId(params: Record<string, unknown>): string | null {
  const direct = params["modelId"];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const model = params["model"];
  if (typeof model === "object" && model !== null && !Array.isArray(model)) {
    const nested = (model as Record<string, unknown>)["modelId"];
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  }
  return null;
}

function readApprovalMode(params: Record<string, unknown>): string | null {
  const mode = params["mode"] ?? params["approvalMode"];
  return typeof mode === "string" && mode.length > 0 ? mode : null;
}

export function isMissingRunError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  if (record["kind"] !== "commandRejected") {
    return false;
  }
  const message = typeof record["message"] === "string" ? record["message"] : "";
  return message.includes("missing_run");
}
