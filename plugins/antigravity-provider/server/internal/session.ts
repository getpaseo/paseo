import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ProviderCatalog,
  ProviderCommand,
  ProviderConfigChanges,
  ProviderError,
  ProviderEvent,
  ProviderLaunch,
  ProviderMcpServerConfig,
  ProviderPermissionResponse,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import {
  DEFAULT_MODE,
  estimateModelCostUsd,
  inferModelContextWindow,
  validateSelection,
  type AntigravityModeId,
} from "./catalog.js";
import { canonicalPath, DriverProcess } from "./process.js";
import { PromptFiles } from "./prompt.js";
import {
  extractTargetPaths,
  inferToolName,
  isNativeReadTool,
  isSafeAcceptEditsTool,
  mapAcpToolCall,
  mapAcpToolDetail,
  matchesPreapprovedMcpTool,
  mergeAcpToolCall,
} from "./timeline.js";
import {
  acpElicitationParamsSchema,
  acpInitializeResultSchema,
  acpPromptResultSchema,
  acpRequestPermissionParamsSchema,
  acpSessionNotificationParamsSchema,
  acpSessionResultSchema,
  AntigravityError,
  buildElicitationResponse,
  parseElicitationQuestions,
  persistenceSchema,
  type AcpPermissionOption,
  type AcpSessionUpdate,
  type AcpToolCallPayload,
  type JsonValue,
  type ParsedElicitationQuestion,
} from "./wire.js";

const INTERRUPT_GRACE_MS = 350;

interface ActiveTurn {
  id: string;
  model: string | null;
  started: boolean;
  interrupted: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  contextUsed?: number;
  contextMax?: number;
  updateCostUsd?: number;
}

type PendingPermission =
  | {
      id: string;
      rpcId: string | number;
      kind: "tool";
      toolCall: AcpToolCallPayload;
      name: string;
      detail: ProviderToolCallDetail;
      options: AcpPermissionOption[];
    }
  | {
      id: string;
      rpcId: string | number;
      kind: "question";
      questions: ParsedElicitationQuestion[];
    };

export class Session {
  private readonly id: string;
  private readonly files = new PromptFiles();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly chunkIds = new Map<string, string>();
  private readonly chunkTexts = new Map<string, string>();
  private readonly turnTools = new Map<string, AcpToolCallPayload>();

  private driver: DriverProcess | null = null;
  private conversationId: string | null;
  private defaultModelId: string | null = null;
  private requestedModel: string | null;
  private effectiveModel: string | null;
  private mode: AntigravityModeId;
  private modelDirty = false;
  private modelRevision = 0;
  private modelChangeChain: Promise<void> = Promise.resolve();
  private availableCommands: ProviderCommand[] = [];
  private lastUsage: ProviderUsage = {};
  private accumulatedCostUsd = 0;
  private turn: ActiveTurn | null = null;
  private replayMode: "live" | "replay" | "skip" = "live";
  private replayBuffer: ProviderEvent[] | null = null;
  private readonly replayIndexById = new Map<string, number>();
  private hasOpened = false;
  private itemSeq = 0;
  private permissionSeq = 0;
  private closed = false;

  constructor(
    private readonly options: {
      id: string;
      config: ProviderSessionConfig;
      persistence?: ProviderPersistence;
      catalog: () => ProviderCatalog;
      launch: ProviderLaunch;
      emit: (event: ProviderEvent) => void;
      onTierObserved?: (tierLabel: string) => void;
    },
  ) {
    this.id = options.id;
    const catalog = options.catalog();
    validateSelection(
      {
        model: options.config.model,
        mode: options.config.mode,
        thinkingOption: options.config.thinkingOption,
      },
      catalog,
    );
    const persisted = parsePersistence(options.persistence);
    const persistedModel =
      persisted?.model && catalog.models.some((entry) => entry.id === persisted.model)
        ? persisted.model
        : null;
    this.conversationId = persisted?.conversationId ?? null;
    this.defaultModelId = persisted?.defaultModelId ?? null;
    this.requestedModel = options.config.model ?? persistedModel ?? null;
    this.effectiveModel = this.requestedModel;
    this.mode = (options.config.mode as AntigravityModeId | undefined) ?? DEFAULT_MODE;
    if (typeof persisted?.accumulatedCostUsd === "number") {
      this.accumulatedCostUsd = persisted.accumulatedCostUsd;
      this.lastUsage = { totalCostUsd: persisted.accumulatedCostUsd };
    }
  }

  canStopRuntime(): boolean {
    return this.turn === null && this.pendingPermissions.size === 0;
  }

  async open(
    requestId: string,
    capabilities: readonly string[],
    history: "replay" | "skip",
  ): Promise<void> {
    const replayEvents = await this.ensureDriver(history);
    if (this.closed) return;
    this.hasOpened = true;

    const persistence = this.options.config.persist ? this.currentPersistence() : undefined;
    this.options.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities,
      restoration: "core",
      ...(persistence ? { persistence } : {}),
      ...(this.options.config.title ? { title: this.options.config.title } : {}),
      cwd: this.options.config.cwd,
    });
    if (persistence && this.conversationId) {
      this.options.emit({ type: "session.persistence", sessionId: this.id, persistence });
    }
    this.emitConfig();
    this.options.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: this.availableCommands,
    });
    for (const event of replayEvents) this.options.emit(event);
    this.options.emit({ type: "session.ready", requestId, sessionId: this.id });
  }

  async configure(changes: ProviderConfigChanges): Promise<void> {
    validateSelection(
      {
        model: changes.model ?? undefined,
        mode: changes.mode ?? undefined,
        thinkingOption: changes.thinkingOption ?? undefined,
      },
      this.options.catalog(),
    );
    if (changes.model !== undefined) await this.applyModelChange(changes.model);
    if (changes.mode !== undefined && changes.mode !== null) {
      this.mode = changes.mode as AntigravityModeId;
      this.autoApproveEligiblePendingPermissions();
    }
    this.emitConfig();
    this.emitPersistence();
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.turn) {
      throw new AntigravityError("Antigravity already has an active turn", "TURN_ACTIVE");
    }
    if (prompt.clearPendingPermissions) this.cancelAllPermissions();

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const turnId = `turn-${randomUUID()}`;
    const turn: ActiveTurn = {
      id: turnId,
      model: this.effectiveModel,
      started: false,
      interrupted: false,
      settled,
      resolveSettled,
    };
    this.turn = turn;

    let encoded: Awaited<ReturnType<PromptFiles["encode"]>> | undefined;
    let driver: DriverProcess;
    try {
      encoded = await this.files.encode(prompt);
      if (turn.interrupted || this.closed) {
        this.finishCanceledPreparation(turn, prompt.clientMessageId, encoded.text);
        return;
      }
      driver = await this.ensureLiveDriver();
      if (turn.interrupted || this.closed) {
        this.finishCanceledPreparation(turn, prompt.clientMessageId, encoded.text);
        return;
      }
      if (!this.conversationId) {
        throw new AntigravityError(
          "Antigravity ACP session has no active conversation ID",
          "PROCESS_FAILED",
        );
      }
    } catch (error) {
      if (turn.interrupted || this.closed) {
        this.finishCanceledPreparation(turn, prompt.clientMessageId, encoded?.text);
        return;
      }
      if (this.turn === turn) this.turn = null;
      turn.resolveSettled();
      throw error;
    }

    turn.model = this.effectiveModel;
    turn.started = true;
    this.resetStreamReducers();

    this.options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        text: encoded.text,
        clientMessageId: prompt.clientMessageId,
      },
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });
    void this.executeTurn(driver, turn, encoded.nativeText);
  }

  private finishCanceledPreparation(
    turn: ActiveTurn,
    clientMessageId: string,
    text?: string,
  ): void {
    if (this.turn === turn) this.turn = null;
    if (text !== undefined) {
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "user_message",
          id: clientMessageId,
          text,
          clientMessageId,
        },
      });
    }
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: turn.id,
      state: "started",
    });
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: turn.id,
      state: "canceled",
    });
    turn.resolveSettled();
  }

  respondToPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;
    this.pendingPermissions.delete(permissionId);

    if (pending.kind === "tool") {
      this.respondToolOutcome(pending.rpcId, selectPermissionOption(pending.options, response));
    } else {
      this.driver?.respond(pending.rpcId, buildElicitationResponse(pending.questions, response));
    }
    this.options.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });

    if (response.behavior === "deny" && response.interrupt) {
      void this.interrupt();
    }
  }

  async interrupt(): Promise<void> {
    const activeTurn = this.turn;
    if (!activeTurn) return;
    activeTurn.interrupted = true;
    this.cancelAllPermissions();

    if (!activeTurn.started) {
      if ((await waitForTurnOrTimeout(activeTurn.settled)) === "timeout") {
        await this.retireDriver();
      }
      await activeTurn.settled;
      return;
    }

    const driver = this.driver;
    if (!driver) {
      await activeTurn.settled;
      return;
    }
    if (this.conversationId) {
      driver.notify("session/cancel", { sessionId: this.conversationId });
    }
    if ((await waitForTurnOrTimeout(activeTurn.settled)) === "settled") return;

    await driver.interrupt();
    if ((await waitForTurnOrTimeout(activeTurn.settled)) === "timeout") {
      await this.retireDriver();
    }
    await activeTurn.settled;
  }

  async close(): Promise<void> {
    const activeTurn = this.turn;
    this.closed = true;
    if (activeTurn) activeTurn.interrupted = true;
    this.cancelAllPermissions();
    await this.retireDriver();
    if (activeTurn) await activeTurn.settled;
    await this.modelChangeChain.catch(() => {});
    await this.retireDriver();
    await this.files.close();
  }

  private applyModelChange(nextModel: string | null): Promise<void> {
    const run = () => this.executeModelChange(nextModel);
    const queued = this.modelChangeChain.then(run, run);
    this.modelChangeChain = queued.catch(() => {});
    return queued;
  }

  private async executeModelChange(nextModel: string | null): Promise<void> {
    if (nextModel === null) {
      const isAlreadyDefault =
        this.requestedModel === null &&
        (this.effectiveModel === null || this.effectiveModel === this.defaultModelId) &&
        !this.modelDirty;
      if (isAlreadyDefault) return;
      const revision = ++this.modelRevision;
      if (this.driver?.isAlive && this.conversationId && !this.turn) {
        if (this.defaultModelId) {
          await this.setLiveModel(this.driver, this.defaultModelId, null, revision);
          return;
        }
        await this.retireDriver();
        if (this.modelRevision === revision) {
          this.requestedModel = null;
          this.effectiveModel = null;
          this.modelDirty = false;
        }
        return;
      }
      this.requestedModel = null;
      this.modelDirty = true;
      return;
    }

    if (
      nextModel === this.requestedModel &&
      nextModel === this.effectiveModel &&
      !this.modelDirty
    ) {
      return;
    }
    const revision = ++this.modelRevision;
    if (this.driver?.isAlive && this.conversationId && !this.turn) {
      await this.setLiveModel(this.driver, nextModel, nextModel, revision);
      return;
    }
    this.requestedModel = nextModel;
    this.modelDirty = true;
  }

  private async setLiveModel(
    driver: DriverProcess,
    targetModel: string,
    requestedModel: string | null,
    revision: number,
  ): Promise<void> {
    try {
      const result = await driver.requestInit(
        "session/set_model",
        { sessionId: this.conversationId, modelId: targetModel },
        acpSessionResultSchema,
      );
      this.effectiveModel = result.models?.currentModelId ?? targetModel;
      if (this.modelRevision === revision) {
        this.requestedModel = requestedModel;
        this.modelDirty = false;
      }
    } catch (error) {
      if (isTrajectoryNotFoundError(error) && this.conversationId) {
        await this.recoverExpiredTrajectory(driver);
        await this.setLiveModel(driver, targetModel, requestedModel, revision);
        return;
      }
      const isTimeout =
        error instanceof Error &&
        error.message.includes("Timed out waiting for Antigravity ACP response");
      if (isTimeout || !driver.isAlive) {
        await this.retireDriver();
        this.modelDirty = true;
      }
      throw error;
    }
  }

  private async recoverExpiredTrajectory(driver: DriverProcess): Promise<string> {
    const sessionResult = await driver.requestInit(
      "session/new",
      this.commonSessionParams(),
      acpSessionResultSchema,
    );
    if (!sessionResult.sessionId) {
      throw new AntigravityError(
        "Antigravity ACP session/new did not return a sessionId",
        "WIRE_PARSE_ERROR",
      );
    }
    this.conversationId = sessionResult.sessionId;
    const reportedModel = sessionResult.models?.currentModelId ?? null;
    await this.syncInitialModel(driver, reportedModel);
    this.emitPersistence();
    return sessionResult.sessionId;
  }

  private commonSessionParams() {
    const mcpServers = toAcpMcpServers(this.options.config.mcpServers);
    const systemPrompt = this.options.config.systemPrompt?.trim();
    const meta = systemPrompt
      ? { antigravity: { systemPrompt: { append: systemPrompt } } }
      : undefined;
    return {
      cwd: this.options.config.cwd,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    };
  }

  private async executeTurn(
    driver: DriverProcess,
    turn: ActiveTurn,
    nativeText: string,
  ): Promise<void> {
    try {
      let response;
      try {
        response = await driver.request(
          "session/prompt",
          { sessionId: this.conversationId, prompt: [{ type: "text", text: nativeText }] },
          acpPromptResultSchema,
        );
      } catch (promptError) {
        if (isTrajectoryNotFoundError(promptError) && this.conversationId && !turn.interrupted) {
          await this.recoverExpiredTrajectory(driver);
          response = await driver.request(
            "session/prompt",
            { sessionId: this.conversationId, prompt: [{ type: "text", text: nativeText }] },
            acpPromptResultSchema,
          );
        } else {
          throw promptError;
        }
      }
      if (this.turn !== turn) return;
      this.turn = null;
      this.cancelAllPermissions();
      if (response.usage) this.emitPromptUsage(turn, response.usage);

      const canceled = turn.interrupted || response.stopReason === "cancelled";
      this.settleTurnTools(canceled ? "failed" : "completed");
      this.options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: turn.id,
        state: canceled ? "canceled" : "completed",
      });
    } catch (error) {
      if (this.turn !== turn) return;
      this.turn = null;
      this.cancelAllPermissions();
      this.settleTurnTools("failed");
      this.options.emit(
        turn.interrupted
          ? { type: "session.turn", sessionId: this.id, turnId: turn.id, state: "canceled" }
          : {
              type: "session.turn",
              sessionId: this.id,
              turnId: turn.id,
              state: "failed",
              error: toProviderError(error),
            },
      );
    } finally {
      turn.resolveSettled();
    }
  }

  private async ensureLiveDriver(): Promise<DriverProcess> {
    await this.modelChangeChain.catch(() => {});
    if (
      this.driver?.isAlive &&
      this.conversationId &&
      !this.driver.hasDirectories(this.files.additionalDirectories)
    ) {
      await this.retireDriver();
    }
    await this.ensureDriver("skip");
    if (!this.driver) {
      throw new AntigravityError("Antigravity ACP process is not running", "PROCESS_FAILED");
    }
    return this.driver;
  }

  private async ensureDriver(history: "replay" | "skip"): Promise<ProviderEvent[]> {
    if (this.closed) {
      throw new AntigravityError("Antigravity ACP session is closed", "PROCESS_FAILED");
    }
    if (this.driver?.isAlive) {
      await this.syncDirtyModel(this.driver);
      return [];
    }
    const driver = this.spawnDriver();
    this.driver = driver;
    try {
      return await this.initializeAcpSession(driver, history);
    } catch (error) {
      if (this.driver === driver) this.driver = null;
      await driver.stop();
      throw error;
    }
  }

  private spawnDriver(): DriverProcess {
    const launch: ProviderLaunch = {
      ...this.options.launch,
      env: { ...this.options.launch.env, ...this.options.config.env },
    };
    const driver = new DriverProcess(
      {
        launch,
        cwd: this.options.config.cwd,
        additionalDirectories: this.files.additionalDirectories,
      },
      {
        onNotification: (method, params) => this.handleNotification(driver, method, params),
        onRequest: (id, method, params) => this.handleServerRequest(driver, id, method, params),
        onExit: () => {
          const wasCurrent = this.driver === driver;
          if (wasCurrent) this.driver = null;
          void driver.stop();
          if (wasCurrent && !this.closed && !this.turn && this.hasOpened) {
            this.options.emit({
              type: "session.runtime_failed",
              sessionId: this.id,
              error: toProviderError(
                new AntigravityError("Antigravity runtime exited unexpectedly", "PROCESS_FAILED"),
              ),
            });
          }
        },
      },
    );
    return driver;
  }

  private async syncDirtyModel(driver: DriverProcess): Promise<void> {
    if (!this.modelDirty || !this.conversationId) return;
    const revision = this.modelRevision;
    const requested = this.requestedModel;
    const targetModel = requested ?? this.defaultModelId;
    if (!targetModel) {
      await this.retireDriver();
      const fresh = this.spawnDriver();
      this.driver = fresh;
      await this.initializeAcpSession(fresh, "skip");
      return;
    }
    await this.setLiveModel(driver, targetModel, requested, revision);
    this.emitConfig();
    this.emitPersistence();
  }

  private async initializeAcpSession(
    driver: DriverProcess,
    history: "replay" | "skip",
  ): Promise<ProviderEvent[]> {
    await driver.requestInit(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "paseo", version: "1.0.0" },
      },
      acpInitializeResultSchema,
    );

    const isFreshSession = this.conversationId === null;
    const { sessionResult, replayEvents } = await this.openOrLoadAcpSession(driver, history);
    const tierName = sessionResult._meta?.antigravity?.tier?.name;
    if (tierName) this.options.onTierObserved?.(tierName);

    const reportedModel = sessionResult.models?.currentModelId ?? null;
    if (this.defaultModelId === null) {
      const catalogDefault = this.options.catalog().defaultModel ?? null;
      this.defaultModelId = isFreshSession
        ? (reportedModel ?? catalogDefault)
        : (catalogDefault ?? reportedModel);
    }

    await this.syncInitialModel(driver, reportedModel);
    return replayEvents;
  }

  private async syncInitialModel(
    driver: DriverProcess,
    reportedModel: string | null,
  ): Promise<void> {
    const revision = this.modelRevision;
    const requested = this.requestedModel;
    const targetModel = this.modelDirty ? (requested ?? this.defaultModelId) : requested;
    if (targetModel && targetModel !== reportedModel) {
      await this.setLiveModel(driver, targetModel, requested, revision);
      if (this.hasOpened) this.emitConfig();
      return;
    }
    this.effectiveModel = targetModel ?? reportedModel ?? this.effectiveModel;
    if (this.modelRevision === revision) {
      this.modelDirty = false;
    }
  }

  private async openOrLoadAcpSession(driver: DriverProcess, history: "replay" | "skip") {
    const commonParams = this.commonSessionParams();

    if (this.conversationId) {
      const buffered: ProviderEvent[] = [];
      this.replayMode = history;
      this.replayBuffer = history === "replay" ? buffered : null;
      this.replayIndexById.clear();
      this.resetStreamReducers();
      try {
        const sessionResult = await driver.requestInit(
          "session/load",
          { sessionId: this.conversationId, ...commonParams },
          acpSessionResultSchema,
        );
        return { sessionResult, replayEvents: buffered };
      } catch (loadError) {
        if (isTrajectoryNotFoundError(loadError)) {
          const sessionResult = await driver.requestInit(
            "session/new",
            commonParams,
            acpSessionResultSchema,
          );
          if (!sessionResult.sessionId) {
            throw new AntigravityError(
              "Antigravity ACP session/new did not return a sessionId",
              "WIRE_PARSE_ERROR",
            );
          }
          this.conversationId = sessionResult.sessionId;
          return { sessionResult, replayEvents: [] as ProviderEvent[] };
        }
        throw loadError;
      } finally {
        this.replayMode = "live";
        this.replayBuffer = null;
        this.replayIndexById.clear();
        this.resetStreamReducers();
      }
    }

    const sessionResult = await driver.requestInit(
      "session/new",
      commonParams,
      acpSessionResultSchema,
    );
    if (!sessionResult.sessionId) {
      throw new AntigravityError(
        "Antigravity ACP session/new did not return a sessionId",
        "WIRE_PARSE_ERROR",
      );
    }
    this.conversationId = sessionResult.sessionId;
    return { sessionResult, replayEvents: [] as ProviderEvent[] };
  }

  private handleNotification(driver: DriverProcess, method: string, params: unknown): void {
    if (this.driver !== driver || this.closed || method !== "session/update") return;
    const parsed = acpSessionNotificationParamsSchema.safeParse(params);
    if (!parsed.success) return;
    if (this.conversationId && parsed.data.sessionId !== this.conversationId) return;
    this.applySessionUpdate(parsed.data.update);
  }

  private applySessionUpdate(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === "available_commands_update") {
      this.availableCommands = update.availableCommands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.input?.hint ? { argumentHint: cmd.input.hint } : {}),
      }));
      if (this.hasOpened) {
        this.options.emit({
          type: "session.commands",
          sessionId: this.id,
          commands: this.availableCommands,
        });
      }
      return;
    }

    if (update.sessionUpdate === "usage_update") {
      if (this.replayMode === "skip") {
        if (typeof update.cost?.amount === "number") {
          this.accumulatedCostUsd = update.cost.amount;
          this.lastUsage = mergeUsageSnapshot(this.lastUsage, { totalCostUsd: update.cost.amount });
        }
        return;
      }
      this.emitUsageUpdate(update);
      return;
    }

    if (this.replayMode === "skip") return;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      this.applyChunkUpdate(update);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.chunkIds.delete("agent_message_chunk");
      this.chunkIds.delete("agent_thought_chunk");
      this.chunkIds.delete("user_message_chunk");
      const merged = mergeAcpToolCall(this.turnTools.get(update.toolCallId), update);
      this.turnTools.set(update.toolCallId, merged);
      this.publishStreamEvent({
        type: "timeline.item",
        sessionId: this.id,
        item: mapAcpToolCall(merged),
      });
      return;
    }
    if (update.sessionUpdate === "plan") {
      const planId = this.resolveChunkId("plan", null);
      this.publishStreamEvent({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "todo",
          id: planId,
          items: update.entries.map((entry, index) => ({
            id: `${planId}:${index}`,
            text: entry.content,
            completed: entry.status === "completed",
            ...(entry.status ? { status: entry.status } : {}),
          })),
        },
      });
    }
  }

  private emitUsageUpdate(
    update: Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>,
  ): void {
    const priorCost = this.accumulatedCostUsd;
    recordTurnUsageUpdate(this.turn, update);
    if (typeof update.cost?.amount === "number") {
      this.accumulatedCostUsd = update.cost.amount;
    }
    const activeModel = this.turn ? this.turn.model : this.effectiveModel;
    const usage = mergeUsageSnapshot(this.lastUsage, {
      inputTokens: update.inputTokens,
      outputTokens: update.outputTokens,
      cachedInputTokens: update.cachedInputTokens,
      contextWindowUsedTokens: positiveOrZero(update.used) ?? this.turn?.contextUsed,
      contextWindowMaxTokens:
        positiveNumber(update.size) ??
        this.turn?.contextMax ??
        inferModelContextWindow(activeModel),
      totalCostUsd: update.cost?.amount,
    });
    if (Object.keys(usage).length === 0) return;
    this.lastUsage = usage;
    this.publishStreamEvent({
      type: "session.usage",
      sessionId: this.id,
      ...(this.turn ? { turnId: this.turn.id } : {}),
      usage,
    });
    if (this.accumulatedCostUsd !== priorCost) {
      this.emitPersistence();
    }
  }

  private emitPromptUsage(
    turn: ActiveTurn,
    raw: NonNullable<ReturnType<typeof acpPromptResultSchema.parse>["usage"]>,
  ): void {
    const priorCost = this.accumulatedCostUsd;
    const contextWindowMaxTokens =
      turn.contextMax ??
      inferModelContextWindow(turn.model) ??
      this.lastUsage.contextWindowMaxTokens;
    const summedTokens =
      (raw.inputTokens ?? 0) + (raw.cachedInputTokens ?? 0) + (raw.outputTokens ?? 0);
    const contextWindowUsedTokens =
      turn.contextUsed ??
      clampUsedTokens(summedTokens, contextWindowMaxTokens) ??
      this.lastUsage.contextWindowUsedTokens;

    const usage = mergeUsageSnapshot(this.lastUsage, {
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cachedInputTokens: raw.cachedInputTokens,
      contextWindowMaxTokens,
      contextWindowUsedTokens,
      totalCostUsd: this.resolveTurnTotalCostUsd(turn, raw),
    });
    this.lastUsage = usage;
    this.options.emit({ type: "session.usage", sessionId: this.id, turnId: turn.id, usage });
    if (this.accumulatedCostUsd !== priorCost) {
      this.emitPersistence();
    }
  }

  private resolveTurnTotalCostUsd(
    turn: ActiveTurn,
    raw: NonNullable<ReturnType<typeof acpPromptResultSchema.parse>["usage"]>,
  ): number | undefined {
    if (raw.totalCostUsd !== undefined) {
      this.accumulatedCostUsd = raw.totalCostUsd;
      return raw.totalCostUsd;
    }
    if (turn.updateCostUsd !== undefined) {
      this.accumulatedCostUsd = turn.updateCostUsd;
      return turn.updateCostUsd;
    }
    const estimated = estimateModelCostUsd(turn.model, raw);
    if (estimated !== undefined) {
      this.accumulatedCostUsd += estimated;
      return Math.round(this.accumulatedCostUsd * 1_000_000) / 1_000_000;
    }
    return this.lastUsage.totalCostUsd;
  }

  private applyChunkUpdate(
    update: Extract<
      AcpSessionUpdate,
      { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" }
    >,
  ): void {
    if (update.sessionUpdate === "user_message_chunk") {
      if (this.replayMode !== "replay") {
        this.chunkIds.clear();
        return;
      }
      this.chunkIds.delete("agent_message_chunk");
      this.chunkIds.delete("agent_thought_chunk");
      this.chunkIds.delete("plan");
      if (update.content.type !== "text" || !update.content.text) return;
      const itemId = this.resolveChunkId("user_message_chunk", update.messageId);
      const nextText = `${this.chunkTexts.get(itemId) ?? ""}${update.content.text}`;
      this.chunkTexts.set(itemId, nextText);
      this.publishStreamEvent({
        type: "timeline.item",
        sessionId: this.id,
        item: { type: "user_message", id: itemId, text: nextText },
      });
      return;
    }

    this.chunkIds.delete("user_message_chunk");
    this.chunkIds.delete(
      update.sessionUpdate === "agent_message_chunk"
        ? "agent_thought_chunk"
        : "agent_message_chunk",
    );
    if (update.content.type !== "text" || !update.content.text) return;
    const itemId = this.resolveChunkId(update.sessionUpdate, update.messageId);
    const nextText = `${this.chunkTexts.get(itemId) ?? ""}${update.content.text}`;
    this.chunkTexts.set(itemId, nextText);
    this.publishStreamEvent({
      type: "timeline.item",
      sessionId: this.id,
      item:
        update.sessionUpdate === "agent_thought_chunk"
          ? { type: "reasoning", id: itemId, text: nextText }
          : { type: "assistant_message", id: itemId, text: nextText },
    });
  }

  private publishStreamEvent(event: ProviderEvent): void {
    if (this.replayBuffer) {
      if (event.type === "timeline.item") {
        const existingIdx = this.replayIndexById.get(event.item.id);
        if (existingIdx !== undefined) {
          this.replayBuffer[existingIdx] = event;
        } else {
          this.replayIndexById.set(event.item.id, this.replayBuffer.length);
          this.replayBuffer.push(event);
        }
      } else {
        this.replayBuffer.push(event);
      }
      return;
    }
    if (this.hasOpened) this.options.emit(event);
  }

  private handleServerRequest(
    driver: DriverProcess,
    rpcId: string | number,
    method: string,
    params: unknown,
  ): void {
    if (this.driver !== driver || this.closed) {
      driver.respondError(rpcId, -32603, "Session is closed");
      return;
    }
    if (method === "session/request_permission") {
      const parsed = acpRequestPermissionParamsSchema.safeParse(params);
      if (!parsed.success) {
        driver.respondError(rpcId, -32602, "Invalid session/request_permission params");
        return;
      }
      this.handleToolPermissionRequest(rpcId, parsed.data);
      return;
    }
    if (method === "elicitation/create") {
      const parsed = acpElicitationParamsSchema.safeParse(params);
      if (!parsed.success) {
        driver.respondError(rpcId, -32602, "Invalid elicitation/create params");
        return;
      }
      this.handleElicitationRequest(rpcId, parsed.data);
      return;
    }
    driver.respondError(rpcId, -32601, `Unsupported client method: ${method}`);
  }

  private handleToolPermissionRequest(
    rpcId: string | number,
    request: { sessionId: string; toolCall: AcpToolCallPayload; options: AcpPermissionOption[] },
  ): void {
    const mergedTool = mergeAcpToolCall(
      this.turnTools.get(request.toolCall.toolCallId),
      request.toolCall,
    );
    this.turnTools.set(request.toolCall.toolCallId, mergedTool);
    const name = inferToolName(mergedTool);
    const input = asJsonRecord(mergedTool.rawInput);
    const detail = mapAcpToolDetail(mergedTool, name, input);

    if (this.shouldAutoApproveTool(mergedTool, name, detail)) {
      this.respondToolOutcome(
        rpcId,
        selectPermissionOption(request.options, { behavior: "allow" }),
      );
      return;
    }

    const permissionId = `perm-${++this.permissionSeq}`;
    this.pendingPermissions.set(permissionId, {
      id: permissionId,
      rpcId,
      kind: "tool",
      toolCall: mergedTool,
      name,
      detail,
      options: request.options,
    });

    this.options.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id: permissionId,
        name,
        kind: "tool",
        ...(mergedTool.title ? { title: mergedTool.title } : {}),
        ...(input ? { input } : {}),
        detail,
        actions: request.options.map((option) => {
          const allow = option.kind.startsWith("allow");
          return {
            id: option.optionId,
            label: option.name,
            behavior: allow ? ("allow" as const) : ("deny" as const),
            variant: allow ? ("primary" as const) : ("danger" as const),
          };
        }),
      },
    });
  }

  private handleElicitationRequest(
    rpcId: string | number,
    params: ReturnType<typeof acpElicitationParamsSchema.parse>,
  ): void {
    const questions = parseElicitationQuestions(params);
    const permissionId = `question-${++this.permissionSeq}`;
    this.pendingPermissions.set(permissionId, {
      id: permissionId,
      rpcId,
      kind: "question",
      questions,
    });

    this.options.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id: permissionId,
        name: "ask_question",
        kind: "question",
        ...(params.message ? { title: params.message } : {}),
        input: {
          questions: questions.map(({ rawEnum: _raw, otherFieldKey: _other, ...q }) => q),
        },
      },
    });
  }

  private shouldAutoApproveTool(
    toolCall: AcpToolCallPayload,
    name: string,
    detail: ProviderToolCallDetail,
  ): boolean {
    if (this.mode === "full-access" || this.isSessionImageRead(toolCall, name, detail)) return true;
    if (matchesPreapprovedMcpTool(toolCall, name, this.options.config.toolPolicy)) return true;
    return this.mode === "accept-edits" && isSafeAcceptEditsTool(toolCall, name);
  }

  private isSessionImageRead(
    toolCall: AcpToolCallPayload,
    name: string,
    detail: ProviderToolCallDetail,
  ): boolean {
    const imagesDir = this.files.directoryPath;
    if (!imagesDir || !isNativeReadTool(toolCall, name)) return false;
    const targets = extractTargetPaths(toolCall, detail);
    if (targets.length === 0) return false;
    const resolvedImagesDir = canonicalPath(imagesDir);
    return targets.every((target) => {
      const resolvedTarget = canonicalPath(target);
      return (
        resolvedTarget === resolvedImagesDir ||
        resolvedTarget.startsWith(`${resolvedImagesDir}${path.sep}`)
      );
    });
  }

  private autoApproveEligiblePendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.kind !== "tool") continue;
      if (!this.shouldAutoApproveTool(pending.toolCall, pending.name, pending.detail)) continue;
      this.pendingPermissions.delete(id);
      this.respondToolOutcome(
        pending.rpcId,
        selectPermissionOption(pending.options, { behavior: "allow" }),
      );
      this.options.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: id,
      });
    }
  }

  private respondToolOutcome(
    rpcId: string | number,
    option: AcpPermissionOption | undefined,
  ): void {
    this.driver?.respond(
      rpcId,
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
  }

  private cancelAllPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      this.driver?.respond(
        pending.rpcId,
        pending.kind === "tool" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" },
      );
      this.options.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: id,
      });
    }
  }

  private resetStreamReducers(): void {
    this.chunkIds.clear();
    this.chunkTexts.clear();
    this.turnTools.clear();
  }

  private settleTurnTools(terminalStatus: "completed" | "failed"): void {
    for (const [id, tool] of this.turnTools) {
      if (tool.status === "completed" || tool.status === "failed") continue;
      const settled: AcpToolCallPayload = { ...tool, status: terminalStatus };
      this.turnTools.set(id, settled);
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: mapAcpToolCall(settled),
      });
    }
  }

  private resolveChunkId(kind: string, messageId: string | null | undefined): string {
    if (messageId) return `${kind}:${messageId}`;
    let existing = this.chunkIds.get(kind);
    if (!existing) {
      existing = `item-${++this.itemSeq}`;
      this.chunkIds.set(kind, existing);
    }
    return existing;
  }

  private currentPersistence(): ProviderPersistence | undefined {
    if (!this.conversationId) return this.options.persistence;
    return {
      version: 1,
      data: {
        conversationId: this.conversationId,
        ...(this.accumulatedCostUsd > 0
          ? { accumulatedCostUsd: Math.round(this.accumulatedCostUsd * 1_000_000) / 1_000_000 }
          : {}),
        ...(this.requestedModel ? { model: this.requestedModel } : {}),
        ...(this.defaultModelId ? { defaultModelId: this.defaultModelId } : {}),
      },
    };
  }

  private emitPersistence(): void {
    if (!this.options.config.persist || !this.conversationId) return;
    const persistence = this.currentPersistence();
    if (persistence) {
      this.options.emit({ type: "session.persistence", sessionId: this.id, persistence });
    }
  }

  private emitConfig(): void {
    const catalog = this.options.catalog();
    const model = this.modelDirty
      ? (this.requestedModel ?? this.defaultModelId ?? catalog.defaultModel)
      : (this.effectiveModel ?? this.requestedModel);
    this.options.emit({
      type: "session.config",
      sessionId: this.id,
      config: {
        ...(model ? { model } : {}),
        mode: this.mode,
        models: catalog.models,
        modes: catalog.modes,
        thinkingOptions: catalog.thinkingOptions ?? [],
        settings: [],
      },
    });
  }

  private async retireDriver(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    if (driver) await driver.stop();
  }
}

function waitForTurnOrTimeout(settled: Promise<void>): Promise<"settled" | "timeout"> {
  return Promise.race([
    settled.then(() => "settled" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), INTERRUPT_GRACE_MS)),
  ]);
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveOrZero(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampUsedTokens(summedTokens: number, maxTokens: number | undefined): number | undefined {
  if (summedTokens <= 0) return undefined;
  return maxTokens !== undefined ? Math.min(maxTokens, summedTokens) : summedTokens;
}

function recordTurnUsageUpdate(
  turn: ActiveTurn | null,
  update: Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>,
): void {
  if (!turn) return;
  const used = positiveOrZero(update.used);
  if (used !== undefined) turn.contextUsed = used;
  const size = positiveNumber(update.size);
  if (size !== undefined) turn.contextMax = size;
  if (update.cost?.amount !== undefined && Number.isFinite(update.cost.amount)) {
    turn.updateCostUsd = update.cost.amount;
  }
}

function mergeUsageSnapshot(base: ProviderUsage, incoming: Partial<ProviderUsage>): ProviderUsage {
  const merged: ProviderUsage = { ...base };
  for (const [key, value] of Object.entries(incoming) as Array<
    [keyof ProviderUsage, number | undefined]
  >) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function parsePersistence(persistence: ProviderPersistence | undefined): {
  conversationId: string | null;
  model?: string;
  defaultModelId?: string;
  accumulatedCostUsd?: number;
} | null {
  if (!persistence) return null;
  const parsed = persistenceSchema.safeParse(persistence.data);
  if (!parsed.success) {
    throw new AntigravityError(
      "Invalid Antigravity session persistence state",
      "INVALID_PERSISTENCE",
    );
  }
  return {
    conversationId: parsed.data.conversationId ?? parsed.data.sessionId ?? null,
    ...(parsed.data.model ? { model: parsed.data.model } : {}),
    ...(parsed.data.defaultModelId ? { defaultModelId: parsed.data.defaultModelId } : {}),
    ...(typeof parsed.data.accumulatedCostUsd === "number"
      ? { accumulatedCostUsd: parsed.data.accumulatedCostUsd }
      : {}),
  };
}

function selectPermissionOption(
  options: AcpPermissionOption[],
  response: ProviderPermissionResponse,
): AcpPermissionOption | undefined {
  if (response.selectedActionId) {
    const exact = options.find((option) => option.optionId === response.selectedActionId);
    if (exact) return exact;
  }
  const order =
    response.behavior === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of order) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  if (response.behavior === "allow") {
    return (
      options.find((option) => option.kind.startsWith("allow")) ??
      options.find((option) => /allow/i.test(option.optionId))
    );
  }
  return (
    options.find((option) => option.kind.startsWith("reject")) ??
    options.find((option) => /deny|reject/i.test(option.optionId))
  );
}

function toAcpMcpServers(
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>> | undefined,
): Array<Record<string, unknown>> {
  if (!mcpServers) return [];
  return Object.entries(mcpServers).map(([name, server]) =>
    server.type === "stdio"
      ? {
          name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([k, value]) => ({ name: k, value })),
        }
      : {
          type: server.type,
          name,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([k, value]) => ({ name: k, value })),
        },
  );
}

function asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof AntigravityError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    code: "ANTIGRAVITY_ERROR",
  };
}

function isTrajectoryNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /trajectory.*not found/i.test(message);
}
