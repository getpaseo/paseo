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
} from "@getpaseo/plugin/server/provider";
import type { Usage } from "../usage.js";
import {
  DEFAULT_MODE,
  inferModelContextWindowMaxTokens,
  validateSelection,
  type AntigravityModeId,
} from "./catalog.js";
import {
  accountLocatorKey,
  resolveAntigravityDataDir,
  resolveConversationDatabasePath,
  resolveConversationTranscriptPath,
} from "./data-dir.js";
import { DriverProcess } from "./process.js";
import { PromptFiles } from "./prompt.js";
import { SubagentManager } from "./subagents.js";
import {
  extractBackgroundTaskKill,
  extractBackgroundTaskLaunch,
  extractSubagentControlAction,
  extractSubagentLaunchInfo,
  extractSubagentListSnapshot,
  extractTargetPaths,
  inferToolName,
  isEditOrReadTool,
  isNativeReadTool,
  mapAcpToolCall,
  mapAcpToolDetail,
  mergeAcpToolCall,
  type BackgroundTaskInfo,
} from "./timeline.js";
import {
  computeStepContextWindowTokens,
  extractTranscriptToolResultOutput,
  isConversationStepWaitingForApproval,
  isNonTerminalStepStatus,
  isWaitingStepStatus,
  JsonlTranscriptReader,
  parseSystemWakeupMessage,
  type SystemWakeupInfo,
  type TranscriptStep,
} from "./transcript.js";
import {
  acpElicitationParamsSchema,
  acpInitializeResultSchema,
  acpPromptResultSchema,
  acpRequestPermissionParamsSchema,
  acpSessionNotificationParamsSchema,
  acpSessionResultSchema,
  AntigravityError,
  buildElicitationResponse,
  buildToolPermissionQuestionResponse,
  isMethodNotFoundError,
  parseElicitationQuestions,
  parseToolPermissionQuestions,
  persistenceSchema,
  selectPermissionOption,
  type AcpElicitationParams,
  type AcpPermissionOption,
  type AcpRequestPermissionParams,
  type AcpSessionUpdate,
  type AcpToolCallPayload,
  type JsonValue,
  type ParsedElicitationQuestion,
} from "./wire.js";

const INTERRUPT_GRACE_MS = 350;
const ROOT_TRANSCRIPT_POLL_MS = 180;
const AUTONOMOUS_TRANSCRIPT_SETTLE_MS = 120;
const AUTONOMOUS_TOOL_STALL_TIMEOUT_MS = 15_000;
const SESSION_LOAD_QUIET_MS = 45;
const SESSION_LOAD_MAX_DRAIN_MS = 5_000;

interface ActiveTurn {
  id: string;
  interrupted: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface PendingPromptStart {
  canceled: boolean;
  abort: () => void;
}

interface AutonomousTurn {
  id: string;
  receivedAcpUpdates: boolean;
  awaitingPlannerResponse: boolean;
  lastPlannerStepIndex: number;
  transcriptReportedWaiting: boolean;
  waitingSince: number | null;
  pendingTranscriptTools: AcpToolCallPayload[];
  settleTimer: NodeJS.Timeout | null;
  toolStallTimer: NodeJS.Timeout | null;
}

type PendingPermission =
  | {
      id: string;
      rpcId: string | number;
      kind: "tool";
      toolCall: AcpToolCallPayload;
      detail: ProviderToolCallDetail;
      options: AcpPermissionOption[];
    }
  | {
      id: string;
      rpcId: string | number;
      kind: "question";
      transport: "elicitation";
      questions: ParsedElicitationQuestion[];
    }
  | {
      id: string;
      rpcId: string | number;
      kind: "question";
      transport: "permission";
      questions: ParsedElicitationQuestion[];
      rawInput?: Readonly<Record<string, JsonValue>>;
      options: AcpPermissionOption[];
    };

interface ActiveBackgroundTaskEntry {
  persistent: boolean;
  isSchedule?: boolean;
  prompt?: string;
  scheduleSignature?: string;
  turnScope?: string;
  acpToolId?: string;
  transcriptToolId?: string;
}

export class Session {
  private readonly id: string;
  private readonly files = new PromptFiles();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly chunkIds = new Map<string, string>();
  private readonly chunkTexts = new Map<string, string>();
  private readonly turnTools = new Map<string, AcpToolCallPayload>();
  private readonly activeBackgroundTasks = new Map<string, ActiveBackgroundTaskEntry>();
  private readonly seenRootSteps = new Set<number>();
  private readonly synthesizedWakeupToolIds = new Set<string>();
  private readonly unstreamedWakeupThoughts: string[] = [];
  private readonly unstreamedWakeupMessages: string[] = [];
  private readonly catchupChunkBuffers = new Map<string, string>();
  private readonly foregroundTranscriptTools: AcpToolCallPayload[] = [];
  private readonly subagents: SubagentManager;
  private readonly dataDir: string;
  private readonly locatorId: string;
  private readonly autonomousToolStallTimeoutMs: number;

  private driver: DriverProcess | null = null;
  private driverInitPromise: Promise<DriverProcess> | null = null;
  private startingPrompt: PendingPromptStart | null = null;
  private rootTranscriptReader: JsonlTranscriptReader | null = null;
  private rootMonitorTimer: NodeJS.Timeout | null = null;
  private rootTranscriptSyncPromise: Promise<void> | null = null;
  private rootTranscriptSyncRequested = false;
  private lastRootStepIndex = -1;
  private latestContextWindowUsedTokens: number | undefined;
  private latestContextWindowMaxTokens: { model: string | null; maxTokens: number } | null = null;
  private conversationId: string | null;
  private model: string | null;
  private defaultModel: string | null = null;
  private mode: AntigravityModeId;
  private modelDirty = false;
  private availableCommands: ProviderCommand[] = [];
  private turn: ActiveTurn | null = null;
  private autonomousTurn: AutonomousTurn | null = null;
  private shouldReplayOnLoad: boolean;
  private replayWindow: "replay" | "skip" | null = null;
  private driverHasStartedPrompt = false;
  private sessionUpdateSeq = 0;
  private opened = false;
  private hasUnstreamedPostTurnSteps = false;
  private awaitingPostTurnCatchupEcho = false;
  private filteringSlashPostTurnCatchup = false;
  private turnSeq = 0;
  private wakeupSeq = 0;
  private lastActiveTurnScope = "initial";
  private chunkEpoch = 0;
  private itemSeq = 0;
  private permissionSeq = 0;
  private closed = false;

  constructor(
    private readonly options: {
      id: string;
      config: ProviderSessionConfig;
      persistence?: ProviderPersistence;
      history?: "replay" | "skip";
      catalog: () => ProviderCatalog;
      launch: ProviderLaunch;
      emit: (event: ProviderEvent) => void;
      usage?: Usage;
    },
  ) {
    this.id = options.id;
    validateSelection(
      {
        model: options.config.model,
        mode: options.config.mode,
        thinkingOption: options.config.thinkingOption,
      },
      options.catalog(),
    );
    const mergedEnv = { ...options.launch.env, ...options.config.env };
    const customStallMs = Number(mergedEnv.AGY_AUTONOMOUS_TOOL_STALL_TIMEOUT_MS);
    this.autonomousToolStallTimeoutMs =
      Number.isFinite(customStallMs) && customStallMs > 0
        ? customStallMs
        : AUTONOMOUS_TOOL_STALL_TIMEOUT_MS;
    if (options.usage) {
      const remembered = options.usage.rememberLaunch(options.launch, options.config.env);
      this.dataDir = remembered.dataDir;
      this.locatorId = remembered.locatorId;
    } else {
      this.dataDir = resolveAntigravityDataDir(mergedEnv);
      this.locatorId = accountLocatorKey(this.dataDir, mergedEnv);
    }
    this.subagents = new SubagentManager(this.id, options.config.cwd, this.dataDir, options.emit);
    this.conversationId = parsePersistenceId(options.persistence);
    this.shouldReplayOnLoad =
      this.conversationId !== null && (options.history ?? "replay") === "replay";
    this.model = options.config.model ?? null;
    this.mode = (options.config.mode as AntigravityModeId | undefined) ?? DEFAULT_MODE;
  }

  canStopRuntime(): boolean {
    if (this.closed) return true;
    if (this.startingPrompt !== null) return false;
    if (this.turn !== null) return false;
    if (this.autonomousTurn !== null) return false;
    if (this.pendingPermissions.size > 0) return false;
    if (this.activeBackgroundTasks.size > 0) return false;
    if (this.subagents.hasRunning()) return false;
    return true;
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    const replaySubagents = this.shouldReplayOnLoad;
    this.subagents.setDeferOpens(true);
    await this.ensureDriver();
    if (this.closed) return;

    await this.initializeRootTranscriptCursor();

    this.options.emit({
      type: "session.opened",
      requestId,
      sessionId: this.id,
      capabilities,
      restoration: "core",
      persistence: this.currentPersistence(),
      title: this.options.config.title,
      cwd: this.options.config.cwd,
    });
    if (this.conversationId) {
      this.options.emit({
        type: "session.persistence",
        sessionId: this.id,
        persistence: { version: 1, data: { conversationId: this.conversationId } },
      });
    }
    this.emitConfig();
    this.emitRestoredContextUsage();
    if (this.availableCommands.length > 0) {
      this.options.emit({
        type: "session.commands",
        sessionId: this.id,
        commands: this.availableCommands,
      });
    }

    if (replaySubagents && this.conversationId) {
      await this.subagents.replayFromRootTranscript(
        resolveConversationTranscriptPath(this.dataDir, this.conversationId),
      );
    } else {
      await this.subagents.flushDeferredOpens(true);
    }

    this.options.emit({
      type: "session.ready",
      requestId,
      sessionId: this.id,
    });

    this.opened = true;
    this.ensureRootMonitor();
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
    if (changes.mode !== undefined && changes.mode !== null) {
      await this.applyModeChange(changes.mode as AntigravityModeId);
    }
    if (changes.model !== undefined) {
      await this.applyModelChange(changes.model);
    }
    this.emitConfig();
  }

  private async applyModeChange(nextMode: AntigravityModeId): Promise<void> {
    const nextSkipPermissions = nextMode === "full-access";
    if (
      this.driver?.isAlive &&
      this.driver.skipPermissions &&
      !nextSkipPermissions &&
      !this.canStopRuntime()
    ) {
      throw new AntigravityError(
        "Cannot switch out of Full access mode while a turn or background task is active",
        "TURN_ACTIVE",
      );
    }
    if (this.driver?.isAlive) {
      if (this.driver.skipPermissions !== nextSkipPermissions) {
        if (this.canStopRuntime()) {
          await this.retireDriver();
        }
      } else if (
        this.mode !== nextMode &&
        this.conversationId &&
        !this.turn &&
        !this.autonomousTurn
      ) {
        await this.syncNativeAcpMode(this.driver, nextMode);
      }
    }
    this.mode = nextMode;
    this.autoApproveEligiblePendingPermissions();
  }

  private async applyModelChange(nextModel: string | null): Promise<void> {
    const targetModel = nextModel ?? this.resolveDefaultModel();
    if (targetModel !== null && targetModel === this.model && !this.modelDirty) return;
    if (nextModel === null && this.model === null && !this.modelDirty) return;

    if (this.driver?.isAlive && this.conversationId && !this.turn && !this.autonomousTurn) {
      if (targetModel) {
        const result = await this.driver.requestInit(
          "session/set_model",
          { sessionId: this.conversationId, modelId: targetModel },
          acpSessionResultSchema,
        );
        this.updateModelSelection(result.models?.currentModelId ?? targetModel);
        this.modelDirty = false;
        return;
      }
      await this.retireDriver();
      this.updateModelSelection(null);
      this.modelDirty = false;
      return;
    }

    this.updateModelSelection(targetModel);
    this.modelDirty = true;
  }

  private resolveDefaultModel(): string | null {
    return this.defaultModel ?? this.options.catalog().models[0]?.id ?? null;
  }

  private effectiveModelId(): string | null {
    return this.model ?? this.resolveDefaultModel();
  }

  private updateModelSelection(nextModel: string | null): void {
    const previousEffective = this.effectiveModelId();
    this.model = nextModel;
    if (this.effectiveModelId() !== previousEffective) {
      this.latestContextWindowMaxTokens = null;
    }
  }

  private resolveContextWindowMaxTokens(): number | undefined {
    const activeModel = this.effectiveModelId();
    if (
      this.latestContextWindowMaxTokens !== null &&
      this.latestContextWindowMaxTokens.model === activeModel
    ) {
      return this.latestContextWindowMaxTokens.maxTokens;
    }
    return inferModelContextWindowMaxTokens(activeModel);
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.clearPendingPermissions) {
      this.cancelAllPermissions();
    }
    if (this.autonomousTurn) {
      await this.trySettleAutonomousTurn(this.autonomousTurn);
    }
    if (this.turn || this.autonomousTurn || this.startingPrompt) {
      throw new AntigravityError("Antigravity already has an active turn", "TURN_ACTIVE");
    }

    const prepared = await this.preparePromptTurn(prompt);
    if (!prepared) return;

    const { driver, encoded } = prepared;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const turnId = `turn-${++this.turnSeq}`;
    const turn: ActiveTurn = {
      id: turnId,
      interrupted: false,
      settled,
      resolveSettled,
    };
    this.turn = turn;
    this.driverHasStartedPrompt = true;
    this.resetTurnState();
    this.armPostTurnCatchupFence(
      prompt.input.type === "command" || isSlashCommandPromptText(encoded.nativeText),
    );
    this.ensureRootMonitor();

    this.emitPromptStarted(prompt, encoded.text, turnId);
    void this.executeTurn(driver, turn, encoded.nativeText);
  }

  private async preparePromptTurn(
    prompt: ProviderPrompt,
  ): Promise<{ driver: DriverProcess; encoded: { text: string; nativeText: string } } | null> {
    let abortStart!: () => void;
    const canceledSignal = new Promise<"canceled">((resolve) => {
      abortStart = () => resolve("canceled");
    });
    const token: PendingPromptStart = { canceled: false, abort: abortStart };
    this.startingPrompt = token;

    try {
      const encoded = await this.files.encode(prompt);
      if (token.canceled || this.closed) {
        this.emitCanceledPreTurnPrompt(prompt, encoded.text);
        return null;
      }

      const driverPromise = this.ensureDriver();
      // Prevent unhandled rejection if canceledSignal wins while driver continues warming.
      void driverPromise.catch(() => {});
      const raceResult = await Promise.race([
        driverPromise.then((driver) => ({ kind: "ready" as const, driver })),
        canceledSignal.then(() => ({ kind: "canceled" as const })),
      ]);
      if (raceResult.kind === "canceled" || token.canceled || this.closed) {
        this.emitCanceledPreTurnPrompt(prompt, encoded.text);
        return null;
      }
      if (!this.conversationId) {
        throw new AntigravityError(
          "Antigravity ACP session has no active conversation ID",
          "PROCESS_FAILED",
        );
      }

      await this.syncRootTranscript();
      if (token.canceled || this.closed) {
        this.emitCanceledPreTurnPrompt(prompt, encoded.text);
        return null;
      }

      if (this.autonomousTurn) {
        await this.trySettleAutonomousTurn(this.autonomousTurn);
      }
      if (this.turn || this.autonomousTurn) {
        throw new AntigravityError("Antigravity already has an active turn", "TURN_ACTIVE");
      }

      return { driver: raceResult.driver, encoded };
    } finally {
      if (this.startingPrompt === token) {
        this.startingPrompt = null;
      }
    }
  }

  private emitPromptStarted(prompt: ProviderPrompt, text: string, turnId: string): void {
    this.options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        text,
        clientMessageId: prompt.clientMessageId,
      },
    });
    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.lastActiveTurnScope = turnId;
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId,
      state: "started",
    });
  }

  private emitCanceledPreTurnPrompt(prompt: ProviderPrompt, text: string): void {
    if (this.closed) return;
    const turnId = `turn-${++this.turnSeq}`;
    this.emitPromptStarted(prompt, text, turnId);
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId,
      state: "canceled",
    });
  }

  respondToPermission(permissionId: string, response: ProviderPermissionResponse): void {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return;
    this.pendingPermissions.delete(permissionId);

    if (pending.kind === "tool") {
      const option = selectPermissionOption(pending.options, response);
      this.driver?.respond(
        pending.rpcId,
        option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
    } else if (pending.transport === "permission") {
      const result = buildToolPermissionQuestionResponse(
        pending.questions,
        pending.rawInput,
        pending.options,
        response,
      );
      this.driver?.respond(pending.rpcId, result);
    } else {
      const result = buildElicitationResponse(pending.questions, response);
      this.driver?.respond(pending.rpcId, result);
    }

    if (response.behavior === "deny" && response.interrupt && this.conversationId) {
      if (this.turn) this.turn.interrupted = true;
      this.driver?.notify("session/cancel", { sessionId: this.conversationId });
      if (!this.turn && this.autonomousTurn) {
        this.settleAutonomousTurn("canceled");
      }
    }

    this.options.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId,
    });

    if (this.autonomousTurn) {
      this.syncAutonomousToolStallGuard(this.autonomousTurn);
      this.scheduleAutonomousSettleCheck();
    }
  }

  async interrupt(): Promise<void> {
    if (this.startingPrompt) {
      this.startingPrompt.canceled = true;
      this.startingPrompt.abort();
      this.cancelAllPermissions();
      return;
    }

    const activeTurn = this.turn;
    const driver = this.driver;
    if (!activeTurn && !this.autonomousTurn) {
      if (!this.subagents.hasRunning() && this.pendingPermissions.size === 0) return;
      this.cancelAllPermissions();
      if (driver && this.conversationId) {
        driver.notify("session/cancel", { sessionId: this.conversationId });
      }
      this.subagents.settleAllRunning("canceled");
      return;
    }

    this.cancelAllPermissions();

    if (!activeTurn && this.autonomousTurn) {
      if (driver && this.conversationId) {
        driver.notify("session/cancel", { sessionId: this.conversationId });
      }
      this.subagents.settleAllRunning("canceled");
      this.settleAutonomousTurn("canceled");
      return;
    }

    if (!activeTurn || !driver) return;
    await this.interruptForegroundTurn(activeTurn, driver);
  }

  private async interruptForegroundTurn(
    activeTurn: ActiveTurn,
    driver: DriverProcess,
  ): Promise<void> {
    activeTurn.interrupted = true;

    if (this.conversationId) {
      driver.notify("session/cancel", { sessionId: this.conversationId });
    }

    const graceResult = await Promise.race([
      activeTurn.settled.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), INTERRUPT_GRACE_MS)),
    ]);

    if (graceResult === "settled") return;

    await driver.interrupt();
    const signalResult = await Promise.race([
      activeTurn.settled.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), INTERRUPT_GRACE_MS)),
    ]);

    if (signalResult === "timeout") {
      await this.retireDriver();
    }
    await activeTurn.settled;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopRootMonitor();
    this.clearPostTurnCatchupState();
    if (this.startingPrompt) {
      this.startingPrompt.canceled = true;
      this.startingPrompt.abort();
      this.startingPrompt = null;
    }
    if (this.turn) this.turn.interrupted = true;
    if (this.autonomousTurn) {
      this.clearAutonomousTimers(this.autonomousTurn);
      this.autonomousTurn = null;
    }
    this.activeBackgroundTasks.clear();
    this.cancelAllPermissions();
    this.subagents.close();
    await this.retireDriver();
    await this.files.close();
  }

  private async executeTurn(
    driver: DriverProcess,
    turn: ActiveTurn,
    nativeText: string,
  ): Promise<void> {
    try {
      const response = await driver.request(
        "session/prompt",
        {
          sessionId: this.conversationId,
          prompt: [{ type: "text", text: nativeText }],
        },
        acpPromptResultSchema,
      );

      if (this.turn !== turn) return;

      await this.syncRootTranscript();
      await this.subagents.settleSyntheticChildrenAfterForegroundTurn();

      if (this.turn !== turn) return;
      this.turn = null;

      const finalState =
        turn.interrupted || response.stopReason === "cancelled" ? "canceled" : "completed";
      if (finalState === "canceled") {
        this.cancelAllPermissions();
      }

      this.emitForegroundTurnUsage(turn.id, response.usage);
      this.settleTurnTools(finalState === "canceled" ? "failed" : "completed");
      this.options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: turn.id,
        state: finalState,
      });

      // Check immediately in case a wakeup landed right as session/prompt returned.
      void this.syncRootTranscript();
    } catch (error) {
      this.handleForegroundTurnFailure(turn, error);
    } finally {
      if (this.awaitingPostTurnCatchupEcho) {
        this.hasUnstreamedPostTurnSteps = true;
      }
      this.releasePostTurnCatchupFence();
      turn.resolveSettled();
    }
  }

  private emitForegroundTurnUsage(
    turnId: string,
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          cachedReadTokens?: number;
          totalCostUsd?: number;
        }
      | undefined,
  ): void {
    if (!usage && this.latestContextWindowUsedTokens === undefined) return;
    const usagePayload = this.buildForegroundUsagePayload(usage);
    if (Object.keys(usagePayload).length === 0) return;
    this.options.emit({
      type: "session.usage",
      sessionId: this.id,
      turnId,
      usage: usagePayload,
    });
  }

  private buildForegroundUsagePayload(
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          cachedReadTokens?: number;
          totalCostUsd?: number;
        }
      | undefined,
  ): Record<string, number> {
    const payload: Record<string, number> = {};
    if (usage?.inputTokens !== undefined) payload.inputTokens = usage.inputTokens;
    if (usage?.outputTokens !== undefined) payload.outputTokens = usage.outputTokens;
    const cached = usage?.cachedInputTokens ?? usage?.cachedReadTokens;
    if (cached !== undefined) payload.cachedInputTokens = cached;
    if (usage?.totalCostUsd !== undefined) payload.totalCostUsd = usage.totalCostUsd;
    if (this.latestContextWindowUsedTokens !== undefined) {
      payload.contextWindowUsedTokens = this.latestContextWindowUsedTokens;
      const maxTokens = this.resolveContextWindowMaxTokens();
      if (maxTokens !== undefined) {
        payload.contextWindowMaxTokens = maxTokens;
      }
    }
    return payload;
  }

  private emitRestoredContextUsage(): void {
    if (this.latestContextWindowUsedTokens === undefined) return;
    const maxTokens = this.resolveContextWindowMaxTokens();
    this.options.emit({
      type: "session.usage",
      sessionId: this.id,
      usage: {
        contextWindowUsedTokens: this.latestContextWindowUsedTokens,
        ...(maxTokens !== undefined ? { contextWindowMaxTokens: maxTokens } : {}),
      },
    });
  }

  private handleForegroundTurnFailure(turn: ActiveTurn, error: unknown): void {
    if (this.turn !== turn) return;
    this.turn = null;
    this.cancelAllPermissions();
    this.settleTurnTools("failed");
    if (turn.interrupted) {
      this.options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: turn.id,
        state: "canceled",
      });
      return;
    }
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: turn.id,
      state: "failed",
      error: toProviderError(error),
    });
  }

  private canRecycleDriver(): boolean {
    if (this.closed) return true;
    if (this.turn !== null || this.autonomousTurn !== null) return false;
    if (this.pendingPermissions.size > 0) return false;
    if (this.activeBackgroundTasks.size > 0) return false;
    if (this.subagents.hasRunning()) return false;
    return true;
  }

  private async ensureDriver(): Promise<DriverProcess> {
    if (this.driverInitPromise) {
      const warmed = await this.driverInitPromise;
      if (
        warmed.isAlive &&
        warmed.skipPermissions === (this.mode === "full-access") &&
        !this.closed
      ) {
        await this.syncDirtyModel(warmed);
        return warmed;
      }
    }

    if (
      this.driver?.isAlive &&
      this.driver.skipPermissions !== (this.mode === "full-access") &&
      this.canRecycleDriver()
    ) {
      await this.retireDriver();
    }

    if (this.driver?.isAlive) {
      await this.syncDirtyModel(this.driver);
      return this.driver;
    }

    const initTask = this.startFreshDriver();
    this.driverInitPromise = initTask;
    try {
      return await initTask;
    } finally {
      if (this.driverInitPromise === initTask) {
        this.driverInitPromise = null;
      }
    }
  }

  private async startFreshDriver(): Promise<DriverProcess> {
    const driver = this.spawnDriver();
    this.driver = driver;

    try {
      await this.initializeAcpSession(driver);
      if (this.closed || this.driver !== driver) {
        await driver.stop();
        throw new AntigravityError("Session closed during driver startup", "CLOSED");
      }
      await this.initializeRootTranscriptCursor();
      if (this.closed || this.driver !== driver) {
        await driver.stop();
        throw new AntigravityError("Session closed during driver startup", "CLOSED");
      }
      this.ensureRootMonitor();
      return driver;
    } catch (error) {
      if (this.driver === driver) this.driver = null;
      await driver.stop();
      throw error;
    }
  }

  private spawnDriver(): DriverProcess {
    this.driverHasStartedPrompt = false;
    const launch: ProviderLaunch = {
      ...this.options.launch,
      env: { ...this.options.launch.env, ...this.options.config.env },
    };
    const driver = new DriverProcess(
      {
        launch,
        cwd: this.options.config.cwd,
        additionalDirectories: this.files.directoryPath ? [this.files.directoryPath] : [],
        skipPermissions: this.mode === "full-access",
      },
      {
        onNotification: (method, params) => this.handleNotification(driver, method, params),
        onRequest: (id, method, params) => this.handleServerRequest(driver, id, method, params),
        onExit: (failure) => {
          if (this.driver !== driver) return;
          this.driver = null;
          this.driverHasStartedPrompt = false;
          this.stopRootMonitor();
          const hadBackgroundWork =
            this.activeBackgroundTasks.size > 0 || this.subagents.hasRunning();
          this.activeBackgroundTasks.clear();
          this.subagents.settleAllRunning("failed");
          if (!this.turn) {
            this.cancelAllPermissions();
            if (this.autonomousTurn) {
              this.settleAutonomousTurn("failed", toProviderError(failure));
            } else if (hadBackgroundWork && !this.closed) {
              this.options.emit({
                type: "session.runtime_failed",
                sessionId: this.id,
                error: toProviderError(failure),
              });
            }
          }
        },
      },
    );
    return driver;
  }

  private async syncDirtyModel(driver: DriverProcess): Promise<void> {
    if (!this.modelDirty || !this.conversationId) return;
    const targetModel = this.model ?? this.resolveDefaultModel();
    if (!targetModel) {
      this.modelDirty = false;
      return;
    }
    const result = await driver.requestInit(
      "session/set_model",
      { sessionId: this.conversationId, modelId: targetModel },
      acpSessionResultSchema,
    );
    this.updateModelSelection(result.models?.currentModelId ?? targetModel);
    this.modelDirty = false;
    this.emitConfig();
  }

  private async initializeAcpSession(driver: DriverProcess): Promise<void> {
    await driver.requestInit(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {} },
        },
        clientInfo: {
          name: "paseo",
          version: "1.0.0",
        },
      },
      acpInitializeResultSchema,
    );

    const sessionResult = await this.openOrLoadAcpSession(driver);
    const tierName = sessionResult._meta?.antigravity?.tier?.name;
    if (tierName) {
      this.options.usage?.rememberTier(this.locatorId, tierName);
    }

    const reportedModel = sessionResult.models?.currentModelId ?? null;
    await this.reconcileInitialModel(driver, reportedModel);
    if (this.mode === "accept-edits") {
      await this.syncNativeAcpMode(driver);
    }
  }

  private async reconcileInitialModel(
    driver: DriverProcess,
    reportedModel: string | null,
  ): Promise<void> {
    if (!this.defaultModel) {
      this.defaultModel =
        (this.options.config.model ? null : reportedModel) ??
        this.options.catalog().models[0]?.id ??
        reportedModel;
    }
    const targetModel = this.model ?? (this.modelDirty ? this.resolveDefaultModel() : null);
    if (targetModel && targetModel !== reportedModel) {
      const modelResult = await driver.requestInit(
        "session/set_model",
        { sessionId: this.conversationId, modelId: targetModel },
        acpSessionResultSchema,
      );
      this.updateModelSelection(modelResult.models?.currentModelId ?? targetModel);
    } else if (reportedModel) {
      this.updateModelSelection(reportedModel);
    }
    this.modelDirty = false;
  }

  private async syncNativeAcpMode(
    driver: DriverProcess,
    mode: AntigravityModeId = this.mode,
  ): Promise<void> {
    if (!this.conversationId || driver.skipPermissions) return;
    const nativeMode = mode === "accept-edits" ? "accept-edits" : "default";
    try {
      await driver.requestInit(
        "session/set_mode",
        { sessionId: this.conversationId, modeId: nativeMode },
        acpSessionResultSchema,
      );
    } catch (error) {
      // Older agy builds may not implement session/set_mode; client-side permission rules remain active.
      if (isMethodNotFoundError(error)) return;
      throw error;
    }
  }

  private async openOrLoadAcpSession(driver: DriverProcess) {
    this.clearPostTurnCatchupState();
    const mcpServers = toAcpMcpServers(this.options.config.mcpServers);
    const systemPrompt = this.options.config.systemPrompt?.trim();
    const meta = systemPrompt
      ? { antigravity: { systemPrompt: { append: systemPrompt } } }
      : undefined;

    if (this.conversationId) {
      const replay = this.shouldReplayOnLoad;
      this.shouldReplayOnLoad = false;
      this.replayWindow = replay ? "replay" : "skip";
      this.resetTurnState();
      try {
        const loaded = await driver.requestInit(
          "session/load",
          {
            sessionId: this.conversationId,
            cwd: this.options.config.cwd,
            mcpServers,
            ...(meta ? { _meta: meta } : {}),
          },
          acpSessionResultSchema,
        );
        await this.drainSessionLoadUpdates(driver);
        return loaded;
      } finally {
        this.replayWindow = null;
        this.resetTurnState();
      }
    }

    const sessionResult = await driver.requestInit(
      "session/new",
      {
        cwd: this.options.config.cwd,
        mcpServers,
        ...(meta ? { _meta: meta } : {}),
      },
      acpSessionResultSchema,
    );
    if (!sessionResult.sessionId) {
      throw new AntigravityError(
        "Antigravity ACP session/new did not return a sessionId",
        "WIRE_PARSE_ERROR",
      );
    }
    this.conversationId = sessionResult.sessionId;
    return sessionResult;
  }

  private async drainSessionLoadUpdates(driver: DriverProcess): Promise<void> {
    const deadline = Date.now() + SESSION_LOAD_MAX_DRAIN_MS;
    while (!this.closed && this.driver === driver && driver.isAlive) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const seqBefore = this.sessionUpdateSeq;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(SESSION_LOAD_QUIET_MS, remaining));
        timer.unref?.();
      });
      if (this.sessionUpdateSeq === seqBefore) {
        return;
      }
    }
  }

  private bindRootTranscriptReader(): void {
    if (!this.conversationId) return;
    const expectedPath = resolveConversationTranscriptPath(this.dataDir, this.conversationId);
    if (!this.rootTranscriptReader || this.rootTranscriptReader.filePath !== expectedPath) {
      this.rootTranscriptReader = new JsonlTranscriptReader(expectedPath);
      this.seenRootSteps.clear();
      this.lastRootStepIndex = -1;
    }
  }

  private async initializeRootTranscriptCursor(): Promise<void> {
    if (this.rootTranscriptSyncPromise) {
      await this.rootTranscriptSyncPromise;
    }
    this.bindRootTranscriptReader();
    if (!this.rootTranscriptReader) return;
    const existingSteps = await this.rootTranscriptReader.readNewSteps({
      allowTrailingWithoutNewline: true,
      advancePastUnfinished: true,
    });
    for (const step of existingSteps) {
      this.seenRootSteps.add(step.stepIndex);
      if (step.stepIndex > this.lastRootStepIndex) {
        this.lastRootStepIndex = step.stepIndex;
      }
      const contextUsed = computeStepContextWindowTokens(step);
      if (contextUsed !== undefined) {
        this.latestContextWindowUsedTokens = contextUsed;
      }
    }
  }

  private ensureRootMonitor(): void {
    if (!this.opened || this.rootMonitorTimer || this.closed || !this.driver?.isAlive) return;
    this.rootMonitorTimer = setInterval(() => {
      void this.syncRootTranscript();
    }, ROOT_TRANSCRIPT_POLL_MS);
    this.rootMonitorTimer.unref?.();
  }

  private stopRootMonitor(): void {
    if (this.rootMonitorTimer) {
      clearInterval(this.rootMonitorTimer);
      this.rootMonitorTimer = null;
    }
  }

  private async syncRootTranscript(): Promise<void> {
    if (this.closed || !this.rootTranscriptReader) return;
    this.rootTranscriptSyncRequested = true;
    if (this.rootTranscriptSyncPromise) {
      await this.rootTranscriptSyncPromise;
      return;
    }
    this.rootTranscriptSyncPromise = (async () => {
      try {
        while (this.rootTranscriptSyncRequested && !this.closed && this.rootTranscriptReader) {
          this.rootTranscriptSyncRequested = false;
          const steps = await this.rootTranscriptReader.readNewSteps({
            allowTrailingWithoutNewline: false,
          });
          for (const step of steps) {
            if (this.seenRootSteps.has(step.stepIndex)) continue;
            if (this.shouldDeferRootTranscriptStep(step)) continue;
            this.seenRootSteps.add(step.stepIndex);
            if (step.stepIndex > this.lastRootStepIndex) {
              this.lastRootStepIndex = step.stepIndex;
            }
            await this.applyRootTranscriptStep(step);
          }
        }
      } finally {
        this.rootTranscriptSyncPromise = null;
      }
    })();
    await this.rootTranscriptSyncPromise;
  }

  private shouldDeferRootTranscriptStep(step: TranscriptStep): boolean {
    if (step.type === "PLANNER_RESPONSE" && isNonTerminalStepStatus(step.status)) {
      return true;
    }
    if (step.type === "GENERIC" && isWaitingStepStatus(step.status)) {
      if (this.turn === null && this.autonomousTurn) {
        this.autonomousTurn.transcriptReportedWaiting = true;
        this.syncAutonomousToolStallGuard(this.autonomousTurn);
      }
      return true;
    }
    return false;
  }

  private async applyRootTranscriptStep(step: TranscriptStep): Promise<void> {
    const contextUsed = computeStepContextWindowTokens(step);
    if (contextUsed !== undefined) {
      this.latestContextWindowUsedTokens = contextUsed;
    }

    const wakeup = parseSystemWakeupMessage(step);

    if (this.turn !== null) {
      await this.applyInTurnTranscriptStep(step, wakeup);
      return;
    }

    await this.applyPostTurnTranscriptStep(step, wakeup);
  }

  private async applyInTurnTranscriptStep(
    step: TranscriptStep,
    wakeup: SystemWakeupInfo | null,
  ): Promise<void> {
    if (wakeup) {
      // Split assistant message bubbles across in-turn background/subagent wakeups.
      this.chunkIds.clear();
      this.chunkEpoch += 1;
      this.acknowledgeWakeupTask(wakeup);
      await this.subagents.handleParentWakeupSender(wakeup.sender);
      return;
    }

    if (step.type === "PLANNER_RESPONSE") {
      for (const pending of this.foregroundTranscriptTools.splice(0)) {
        this.inspectToolSideEffects({ ...pending, status: "failed" }, "transcript");
      }
      if (this.turn) {
        const usagePayload = this.buildTranscriptStepUsagePayload(step);
        if (Object.keys(usagePayload).length > 0) {
          this.options.emit({
            type: "session.usage",
            sessionId: this.id,
            turnId: this.turn.id,
            usage: usagePayload,
          });
        }
      }
      if (step.toolCalls.length > 0) {
        step.toolCalls.forEach((call, index) => {
          const payload: AcpToolCallPayload = {
            toolCallId: call.id ?? `fg-tool-${step.stepIndex}-${index}`,
            title: call.name,
            status: "in_progress",
            rawInput: call.args,
          };
          this.foregroundTranscriptTools.push(payload);
          this.inspectToolSideEffects(payload, "transcript");
        });
      }
      return;
    }

    if (step.type === "GENERIC" && this.foregroundTranscriptTools.length > 0) {
      const pending = this.foregroundTranscriptTools.shift()!;
      const output = extractTranscriptToolResultOutput(step);
      const completed: AcpToolCallPayload = {
        ...pending,
        status: step.status === "ERROR" ? "failed" : "completed",
        ...(output !== undefined ? { rawOutput: { output } } : {}),
      };
      this.inspectToolSideEffects(completed, "transcript");
    }
  }

  private async applyPostTurnTranscriptStep(
    step: TranscriptStep,
    wakeup: SystemWakeupInfo | null,
  ): Promise<void> {
    if (!this.autonomousTurn?.receivedAcpUpdates && step.type !== "USER_INPUT") {
      this.hasUnstreamedPostTurnSteps = true;
    }

    if (wakeup) {
      this.acknowledgeWakeupTask(wakeup);
      await this.subagents.handleParentWakeupSender(wakeup.sender);
      const auto = this.ensureAutonomousTurn("transcript");
      auto.awaitingPlannerResponse = true;
      auto.lastPlannerStepIndex = Math.max(auto.lastPlannerStepIndex, step.stepIndex);
      return;
    }

    const auto = this.autonomousTurn;
    if (!auto) return;

    if (step.type === "PLANNER_RESPONSE") {
      this.applyAutonomousPlannerStep(auto, step);
      return;
    }
    if (step.type === "GENERIC" && auto.pendingTranscriptTools.length > 0) {
      this.applyAutonomousToolResultStep(auto, step);
    }
  }

  private applyAutonomousPlannerStep(auto: AutonomousTurn, step: TranscriptStep): void {
    this.flushUnpairedAutonomousTranscriptTools(auto, step.createdAt);
    auto.lastPlannerStepIndex = Math.max(auto.lastPlannerStepIndex, step.stepIndex);
    auto.transcriptReportedWaiting = false;
    auto.waitingSince = null;
    auto.awaitingPlannerResponse = false;

    if (!auto.receivedAcpUpdates) {
      this.emitAutonomousPlannerTextAndUsage(auto, step);
    }

    if (step.toolCalls.length > 0) {
      this.enqueueAutonomousToolCalls(auto, step);
      return;
    }

    if (step.status === "ERROR") {
      this.failAutonomousPlannerStep(auto, step);
      return;
    }

    if (
      step.status === "CANCELED" ||
      step.status === "CANCELLED" ||
      step.status === "INTERRUPTED"
    ) {
      this.settleAutonomousTurn("canceled");
      return;
    }

    this.scheduleAutonomousSettleCheck(AUTONOMOUS_TRANSCRIPT_SETTLE_MS);
  }

  private flushUnpairedAutonomousTranscriptTools(auto: AutonomousTurn, timestamp?: string): void {
    if (auto.pendingTranscriptTools.length === 0) return;
    for (const pending of auto.pendingTranscriptTools.splice(0)) {
      const settledPayload: AcpToolCallPayload = {
        ...pending,
        status: "failed",
      };
      if (!auto.receivedAcpUpdates) {
        this.synthesizedWakeupToolIds.add(settledPayload.toolCallId);
        this.options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: mapAcpToolCall(settledPayload),
          ...(timestamp ? { timestamp } : {}),
        });
      }
      this.inspectToolSideEffects(settledPayload, "transcript");
    }
    this.syncAutonomousToolStallGuard(auto);
  }

  private emitAutonomousPlannerTextAndUsage(auto: AutonomousTurn, step: TranscriptStep): void {
    if (step.thinking?.trim()) {
      this.unstreamedWakeupThoughts.push(step.thinking);
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "reasoning",
          id: `wakeup-thought-${step.stepIndex}`,
          text: step.thinking,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    if (step.content?.trim()) {
      this.unstreamedWakeupMessages.push(step.content);
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "assistant_message",
          id: `wakeup-assistant-${step.stepIndex}`,
          text: step.content,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    const usagePayload = this.buildTranscriptStepUsagePayload(step);
    if (Object.keys(usagePayload).length > 0) {
      this.options.emit({
        type: "session.usage",
        sessionId: this.id,
        turnId: auto.id,
        usage: usagePayload,
      });
    }
  }

  private buildTranscriptStepUsagePayload(step: TranscriptStep): Record<string, number> {
    const payload: Record<string, number> = {};
    if (step.inputTokens !== undefined) payload.inputTokens = step.inputTokens;
    if (step.cacheReadTokens !== undefined) payload.cachedInputTokens = step.cacheReadTokens;
    if (step.outputTokens !== undefined) payload.outputTokens = step.outputTokens;
    if (this.latestContextWindowUsedTokens !== undefined) {
      payload.contextWindowUsedTokens = this.latestContextWindowUsedTokens;
      const maxTokens = this.resolveContextWindowMaxTokens();
      if (maxTokens !== undefined) {
        payload.contextWindowMaxTokens = maxTokens;
      }
    }
    return payload;
  }

  private enqueueAutonomousToolCalls(auto: AutonomousTurn, step: TranscriptStep): void {
    auto.awaitingPlannerResponse = true;
    auto.lastPlannerStepIndex = Math.max(auto.lastPlannerStepIndex, step.stepIndex);
    auto.transcriptReportedWaiting = false;
    auto.waitingSince = null;
    step.toolCalls.forEach((call, index) => {
      const payload: AcpToolCallPayload = {
        toolCallId: call.id ?? `wakeup-tool-${step.stepIndex}-${index}`,
        title: call.name,
        status: "in_progress",
        rawInput: call.args,
      };
      auto.pendingTranscriptTools.push(payload);
      if (!auto.receivedAcpUpdates) {
        this.synthesizedWakeupToolIds.add(payload.toolCallId);
        this.options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: mapAcpToolCall(payload),
          ...(step.createdAt ? { timestamp: step.createdAt } : {}),
        });
      }
      this.inspectToolSideEffects(payload, "transcript");
    });
    this.syncAutonomousToolStallGuard(auto);
  }

  private failAutonomousPlannerStep(auto: AutonomousTurn, step: TranscriptStep): void {
    const message = step.error || "Autonomous wakeup turn failed";
    if (!auto.receivedAcpUpdates) {
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "error",
          id: `wakeup-err-${step.stepIndex}`,
          message,
        },
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    this.settleAutonomousTurn("failed", { message, code: "PROCESS_FAILED" });
  }

  private applyAutonomousToolResultStep(auto: AutonomousTurn, step: TranscriptStep): void {
    auto.transcriptReportedWaiting = false;
    auto.waitingSince = null;
    const pending = auto.pendingTranscriptTools.shift()!;
    const output = extractTranscriptToolResultOutput(step);
    const isFailed = step.status === "ERROR";
    const updatedPayload: AcpToolCallPayload = {
      ...pending,
      status: isFailed ? "failed" : "completed",
      ...(output !== undefined ? { rawOutput: isFailed ? { error: output } : { output } } : {}),
    };
    if (!auto.receivedAcpUpdates) {
      this.synthesizedWakeupToolIds.add(updatedPayload.toolCallId);
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: mapAcpToolCall(updatedPayload),
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    this.inspectToolSideEffects(updatedPayload, "transcript");
    this.syncAutonomousToolStallGuard(auto);
    if (!auto.awaitingPlannerResponse) {
      this.scheduleAutonomousSettleCheck(AUTONOMOUS_TRANSCRIPT_SETTLE_MS);
    }
  }

  private acknowledgeWakeupTask(wakeup: SystemWakeupInfo): void {
    const candidates = [wakeup.finishedTaskId, wakeup.failedTaskId, wakeup.sender].filter(
      (id): id is string => Boolean(id),
    );
    for (const candidate of candidates) {
      const exact = this.activeBackgroundTasks.get(candidate);
      if (exact) {
        if (!exact.persistent || Boolean(wakeup.failedTaskId)) {
          this.activeBackgroundTasks.delete(candidate);
        }
        return;
      }
    }
    // Also clear any synthetic one-shot schedule:<key> if a schedule/timer wakeup arrived
    if (
      wakeup.sender === "scheduler" ||
      wakeup.sender?.includes("schedule") ||
      (candidates.length === 0 && this.activeBackgroundTasks.size > 0)
    ) {
      this.clearScheduleWakeupTask(wakeup.message);
    }
  }

  private clearScheduleWakeupTask(wakeupMessage: string): void {
    let fallbackTaskId: string | null = null;
    for (const [taskId, entry] of this.activeBackgroundTasks) {
      if ((!entry.isSchedule && !taskId.startsWith("schedule:")) || entry.persistent) continue;
      if (entry.prompt && wakeupMessage.includes(entry.prompt)) {
        this.activeBackgroundTasks.delete(taskId);
        return;
      }
      fallbackTaskId ??= taskId;
    }
    if (fallbackTaskId) {
      this.activeBackgroundTasks.delete(fallbackTaskId);
    }
  }

  private ensureAutonomousTurn(source: "acp" | "transcript"): AutonomousTurn {
    if (this.autonomousTurn) return this.autonomousTurn;
    this.resetTurnState();
    const turnId = `wakeup-${++this.wakeupSeq}`;
    this.lastActiveTurnScope = turnId;
    const auto: AutonomousTurn = {
      id: turnId,
      receivedAcpUpdates: source === "acp",
      awaitingPlannerResponse: true,
      lastPlannerStepIndex: this.lastRootStepIndex,
      transcriptReportedWaiting: false,
      waitingSince: null,
      pendingTranscriptTools: [],
      settleTimer: null,
      toolStallTimer: null,
    };
    this.autonomousTurn = auto;
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId,
      state: "started",
    });
    return auto;
  }

  private isAutonomousToolWaitingForApproval(auto: AutonomousTurn): boolean {
    if (auto.transcriptReportedWaiting) return true;
    if (!this.conversationId) return false;
    return isConversationStepWaitingForApproval(
      resolveConversationDatabasePath(this.dataDir, this.conversationId),
      auto.lastPlannerStepIndex,
    );
  }

  private syncAutonomousToolStallGuard(auto: AutonomousTurn): void {
    const shouldMonitor =
      this.autonomousTurn === auto &&
      !this.driver?.skipPermissions &&
      !auto.receivedAcpUpdates &&
      auto.pendingTranscriptTools.length > 0 &&
      this.pendingPermissions.size === 0;
    if (!shouldMonitor) {
      auto.waitingSince = null;
      this.clearAutonomousToolStallTimeout(auto);
      return;
    }
    this.clearAutonomousToolStallTimeout(auto);
    const pollMs = Math.min(250, Math.max(25, Math.floor(this.autonomousToolStallTimeoutMs / 3)));
    auto.toolStallTimer = setTimeout(() => {
      auto.toolStallTimer = null;
      if (this.autonomousTurn !== auto || this.closed) return;
      if (
        auto.pendingTranscriptTools.length === 0 ||
        this.pendingPermissions.size > 0 ||
        this.driver?.skipPermissions ||
        auto.receivedAcpUpdates
      ) {
        auto.waitingSince = null;
        return;
      }
      if (this.isAutonomousToolWaitingForApproval(auto)) {
        const now = Date.now();
        if (auto.waitingSince === null) {
          auto.waitingSince = now;
        }
        if (now - auto.waitingSince >= this.autonomousToolStallTimeoutMs) {
          void this.abortStalledAutonomousTools(
            auto,
            "Background wakeup cannot prompt for interactive tool approval after a turn has ended. Switch session mode to Full access for unattended background tool execution.",
          );
          return;
        }
      } else {
        auto.waitingSince = null;
      }
      this.syncAutonomousToolStallGuard(auto);
    }, pollMs);
    auto.toolStallTimer.unref?.();
  }

  private clearAutonomousToolStallTimeout(auto: AutonomousTurn): void {
    if (auto.toolStallTimer) {
      clearTimeout(auto.toolStallTimer);
      auto.toolStallTimer = null;
    }
  }

  private async abortStalledAutonomousTools(auto: AutonomousTurn, reason: string): Promise<void> {
    if (this.conversationId) {
      this.driver?.notify("session/cancel", { sessionId: this.conversationId });
    }
    for (const pending of auto.pendingTranscriptTools.splice(0)) {
      const failedPayload: AcpToolCallPayload = {
        ...pending,
        status: "failed",
        rawOutput: { error: reason },
      };
      if (!auto.receivedAcpUpdates) {
        this.options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: mapAcpToolCall(failedPayload),
        });
      }
    }
    auto.awaitingPlannerResponse = false;
    await this.retireDriver();
    if (this.autonomousTurn === auto) {
      this.settleAutonomousTurn("completed");
    }
  }

  private clearAutonomousTimers(auto: AutonomousTurn): void {
    if (auto.settleTimer) {
      clearTimeout(auto.settleTimer);
      auto.settleTimer = null;
    }
    this.clearAutonomousToolStallTimeout(auto);
  }

  private scheduleAutonomousSettleCheck(delayMs = AUTONOMOUS_TRANSCRIPT_SETTLE_MS): void {
    const auto = this.autonomousTurn;
    if (!auto || this.closed) return;
    if (auto.settleTimer) {
      clearTimeout(auto.settleTimer);
      auto.settleTimer = null;
    }
    auto.settleTimer = setTimeout(() => {
      void this.trySettleAutonomousTurn(auto);
    }, delayMs);
    auto.settleTimer.unref?.();
  }

  private async trySettleAutonomousTurn(auto: AutonomousTurn): Promise<void> {
    if (this.closed || this.autonomousTurn !== auto) return;
    await this.syncRootTranscript();
    if (this.closed || this.autonomousTurn !== auto) return;

    if (this.pendingPermissions.size > 0) return;
    if (auto.awaitingPlannerResponse) return;
    if (auto.pendingTranscriptTools.length > 0) return;
    for (const tool of this.turnTools.values()) {
      if (tool.status !== "completed" && tool.status !== "failed") {
        return;
      }
    }

    this.settleAutonomousTurn("completed");
  }

  private settleAutonomousTurn(
    state: "completed" | "failed" | "canceled",
    error?: ProviderError,
  ): void {
    const auto = this.autonomousTurn;
    if (!auto) return;
    this.clearAutonomousTimers(auto);
    this.autonomousTurn = null;
    this.settleTurnTools(state === "completed" ? "completed" : "failed");
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: auto.id,
      state,
      ...(error ? { error } : {}),
    });
  }

  private inspectToolSideEffects(tool: AcpToolCallPayload, source: "acp" | "transcript"): void {
    const launchInfo = extractSubagentLaunchInfo(tool, this.options.config.cwd);
    if (launchInfo) {
      this.subagents.registerLaunch(this.id, launchInfo);
    }
    const control = extractSubagentControlAction(tool);
    if (control) {
      this.subagents.applyControlAction(control);
    }
    const listSnapshot = extractSubagentListSnapshot(tool);
    if (listSnapshot) {
      void this.subagents.reconcileActiveList(listSnapshot);
    }
    this.recordBackgroundTaskSides(tool, source);
  }

  private recordBackgroundTaskSides(tool: AcpToolCallPayload, source: "acp" | "transcript"): void {
    if (this.replayWindow !== null) return;
    if (tool.status === "failed") {
      this.removeFailedScheduleLaunch(tool.toolCallId, source);
      return;
    }
    const bgLaunch = extractBackgroundTaskLaunch(tool);
    if (bgLaunch) {
      this.upsertBackgroundTaskLaunch(tool.toolCallId, bgLaunch, source);
    }
    const killedTask = extractBackgroundTaskKill(tool);
    if (killedTask) {
      this.activeBackgroundTasks.delete(killedTask);
    }
  }

  private removeFailedScheduleLaunch(toolCallId: string, source: "acp" | "transcript"): void {
    for (const [key, entry] of this.activeBackgroundTasks) {
      const matched =
        source === "acp" ? entry.acpToolId === toolCallId : entry.transcriptToolId === toolCallId;
      if (matched) {
        this.activeBackgroundTasks.delete(key);
        return;
      }
    }
  }

  private upsertBackgroundTaskLaunch(
    toolCallId: string,
    bgLaunch: BackgroundTaskInfo,
    source: "acp" | "transcript",
  ): void {
    if (!bgLaunch.isSchedule) {
      this.activeBackgroundTasks.set(bgLaunch.taskId, { persistent: bgLaunch.persistent });
      return;
    }
    const matchedKey = this.findMatchingScheduleTaskKey(toolCallId, bgLaunch, source);
    const existing = matchedKey ? this.activeBackgroundTasks.get(matchedKey) : undefined;
    if (matchedKey && matchedKey !== bgLaunch.taskId && !bgLaunch.taskId.startsWith("schedule:")) {
      this.activeBackgroundTasks.delete(matchedKey);
    }
    const targetKey =
      matchedKey && bgLaunch.taskId.startsWith("schedule:") ? matchedKey : bgLaunch.taskId;
    this.activeBackgroundTasks.set(targetKey, {
      ...existing,
      persistent: bgLaunch.persistent,
      isSchedule: true,
      ...(bgLaunch.prompt ? { prompt: bgLaunch.prompt } : {}),
      ...(bgLaunch.scheduleSignature ? { scheduleSignature: bgLaunch.scheduleSignature } : {}),
      turnScope: existing?.turnScope ?? this.lastActiveTurnScope,
      ...(source === "acp" ? { acpToolId: toolCallId } : { transcriptToolId: toolCallId }),
    });
  }

  private findMatchingScheduleTaskKey(
    toolCallId: string,
    bgLaunch: BackgroundTaskInfo,
    source: "acp" | "transcript",
  ): string | undefined {
    for (const [key, entry] of this.activeBackgroundTasks) {
      const sameTool =
        source === "acp" ? entry.acpToolId === toolCallId : entry.transcriptToolId === toolCallId;
      if (sameTool) return key;
    }
    if (this.activeBackgroundTasks.has(bgLaunch.taskId)) {
      return bgLaunch.taskId;
    }
    for (const [key, entry] of this.activeBackgroundTasks) {
      if (!entry.isSchedule) continue;
      if (entry.turnScope !== this.lastActiveTurnScope) continue;
      if (entry.scheduleSignature !== bgLaunch.scheduleSignature) continue;
      const channelFree = source === "acp" ? !entry.acpToolId : !entry.transcriptToolId;
      if (channelFree) return key;
    }
    return undefined;
  }

  private isPostTurnLive(): boolean {
    return this.turn === null && this.replayWindow === null && this.driverHasStartedPrompt;
  }

  private shouldDropSessionUpdate(): boolean {
    if (this.replayWindow === "skip") return true;
    return this.replayWindow === null && this.turn === null && !this.driverHasStartedPrompt;
  }

  private markAutonomousAcpActivity(auto: AutonomousTurn): void {
    auto.receivedAcpUpdates = true;
    auto.waitingSince = null;
    this.clearAutonomousToolStallTimeout(auto);
    if (!auto.awaitingPlannerResponse) {
      this.scheduleAutonomousSettleCheck(AUTONOMOUS_TRANSCRIPT_SETTLE_MS);
    }
  }

  private handleNotification(driver: DriverProcess, method: string, params: unknown): void {
    if (this.driver !== driver || this.closed || method !== "session/update") return;
    this.sessionUpdateSeq += 1;
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
      this.options.emit({
        type: "session.commands",
        sessionId: this.id,
        commands: this.availableCommands,
      });
      return;
    }

    if (this.shouldDropSessionUpdate()) return;
    const filteredUpdate = this.filterPostTurnCatchupUpdate(update);
    if (!filteredUpdate) return;
    update = filteredUpdate;

    const isPostTurnLive = this.isPostTurnLive();

    if (update.sessionUpdate === "usage_update") {
      if (isPostTurnLive && this.autonomousTurn) {
        this.markAutonomousAcpActivity(this.autonomousTurn);
      }
      this.emitUsageUpdate(update);
      return;
    }

    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      if (isPostTurnLive && update.sessionUpdate !== "user_message_chunk") {
        this.markAutonomousAcpActivity(this.ensureAutonomousTurn("acp"));
      }
      this.applyChunkUpdate(update);
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (isPostTurnLive) {
        this.markAutonomousAcpActivity(this.ensureAutonomousTurn("acp"));
      }
      this.chunkIds.clear();
      this.chunkEpoch += 1;
      const merged = mergeAcpToolCall(this.turnTools.get(update.toolCallId), update);
      this.turnTools.set(update.toolCallId, merged);
      this.inspectToolSideEffects(merged, "acp");
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: mapAcpToolCall(merged),
      });
    }
  }

  private emitUsageUpdate(
    update: Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>,
  ): void {
    if (update.used !== undefined) {
      this.latestContextWindowUsedTokens = update.used;
    }
    if (update.size !== undefined && update.size > 0) {
      this.latestContextWindowMaxTokens = {
        model: this.effectiveModelId(),
        maxTokens: update.size,
      };
    }
    const activeTurnId = this.turn?.id ?? this.autonomousTurn?.id;
    const cachedInputTokens = update.cachedInputTokens ?? update.cachedReadTokens;
    const resolvedMaxTokens =
      update.size ?? (update.used !== undefined ? this.resolveContextWindowMaxTokens() : undefined);
    this.options.emit({
      type: "session.usage",
      sessionId: this.id,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      usage: {
        ...(update.inputTokens !== undefined ? { inputTokens: update.inputTokens } : {}),
        ...(update.outputTokens !== undefined ? { outputTokens: update.outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(update.used !== undefined ? { contextWindowUsedTokens: update.used } : {}),
        ...(resolvedMaxTokens !== undefined ? { contextWindowMaxTokens: resolvedMaxTokens } : {}),
        ...(update.cost?.amount !== undefined ? { totalCostUsd: update.cost.amount } : {}),
      },
    });
  }

  private applyChunkUpdate(
    update: Extract<
      AcpSessionUpdate,
      {
        sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      }
    >,
  ): void {
    if (update.sessionUpdate === "user_message_chunk") {
      if (this.replayWindow !== "replay") {
        this.chunkIds.clear();
        return;
      }
      this.chunkIds.delete("agent_message_chunk");
      this.chunkIds.delete("agent_thought_chunk");
      if (update.content.type !== "text" || !update.content.text) return;
      const itemId = this.resolveChunkId("user_message_chunk", update.messageId);
      const nextText = `${this.chunkTexts.get(itemId) ?? ""}${update.content.text}`;
      this.chunkTexts.set(itemId, nextText);
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: {
          type: "user_message",
          id: itemId,
          text: nextText,
          ...(update.messageId ? { messageId: update.messageId } : {}),
        },
      });
      return;
    }
    this.chunkIds.delete(
      update.sessionUpdate === "agent_message_chunk"
        ? "agent_thought_chunk"
        : "agent_message_chunk",
    );
    this.chunkIds.delete("user_message_chunk");
    if (update.content.type !== "text" || !update.content.text) return;
    const itemId = this.resolveChunkId(update.sessionUpdate, update.messageId);
    const nextText = `${this.chunkTexts.get(itemId) ?? ""}${update.content.text}`;
    this.chunkTexts.set(itemId, nextText);
    this.options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item:
        update.sessionUpdate === "agent_thought_chunk"
          ? { type: "reasoning", id: itemId, text: nextText }
          : {
              type: "assistant_message",
              id: itemId,
              text: nextText,
              ...(update.messageId ? { messageId: update.messageId } : {}),
            },
    });
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
      this.handleToolPermissionRequest(driver, rpcId, parsed.data);
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
    driver: DriverProcess,
    rpcId: string | number,
    request: AcpRequestPermissionParams,
  ): void {
    const isRootSession = !this.conversationId || request.sessionId === this.conversationId;
    const mergedTool = isRootSession
      ? mergeAcpToolCall(this.turnTools.get(request.toolCall.toolCallId), request.toolCall)
      : request.toolCall;
    if (isRootSession) {
      this.turnTools.set(request.toolCall.toolCallId, mergedTool);
    }
    const name = inferToolName(mergedTool);
    const input = asJsonRecord(mergedTool.rawInput);
    const questions = parseToolPermissionQuestions(mergedTool, name, request.options);
    if (questions) {
      this.handleToolQuestionPermissionRequest(
        rpcId,
        isRootSession,
        mergedTool,
        input,
        request.options,
        questions,
      );
      return;
    }

    const detail = mapAcpToolDetail(mergedTool, name, input);

    if (this.shouldAutoApproveTool(mergedTool, detail)) {
      const allowOption = selectPermissionOption(request.options, { behavior: "allow" });
      driver.respond(
        rpcId,
        allowOption
          ? { outcome: { outcome: "selected", optionId: allowOption.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
      return;
    }

    if (this.isPostTurnLive() && isRootSession) {
      this.ensureAutonomousTurn("acp");
    }

    const permissionId = `perm-${++this.permissionSeq}`;
    this.pendingPermissions.set(permissionId, {
      id: permissionId,
      rpcId,
      kind: "tool",
      toolCall: mergedTool,
      detail,
      options: request.options,
    });
    if (this.autonomousTurn) {
      this.syncAutonomousToolStallGuard(this.autonomousTurn);
    }

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
          const behavior = option.kind.startsWith("allow") ? ("allow" as const) : ("deny" as const);
          return {
            id: option.optionId,
            label: option.name,
            behavior,
            variant: behavior === "allow" ? ("primary" as const) : ("danger" as const),
          };
        }),
      },
    });
  }

  private handleToolQuestionPermissionRequest(
    rpcId: string | number,
    isRootSession: boolean,
    mergedTool: AcpToolCallPayload,
    input: Record<string, JsonValue> | undefined,
    options: AcpPermissionOption[],
    questions: ParsedElicitationQuestion[],
  ): void {
    if (this.isPostTurnLive() && isRootSession) {
      this.ensureAutonomousTurn("acp");
    }

    const permissionId = `question-${++this.permissionSeq}`;
    this.pendingPermissions.set(permissionId, {
      id: permissionId,
      rpcId,
      kind: "question",
      transport: "permission",
      questions,
      ...(input ? { rawInput: input } : {}),
      options,
    });
    if (this.autonomousTurn) {
      this.syncAutonomousToolStallGuard(this.autonomousTurn);
    }

    const customTitle =
      mergedTool.title && !/ask[_-]?questions?/i.test(mergedTool.title.trim())
        ? mergedTool.title
        : undefined;
    this.emitQuestionPermission(permissionId, questions, customTitle);
  }

  private handleElicitationRequest(rpcId: string | number, params: AcpElicitationParams): void {
    const isRootSession =
      !this.conversationId || !params.sessionId || params.sessionId === this.conversationId;
    if (this.isPostTurnLive() && isRootSession) {
      this.ensureAutonomousTurn("acp");
    }

    const questions = parseElicitationQuestions(params);
    const permissionId = `question-${++this.permissionSeq}`;
    this.pendingPermissions.set(permissionId, {
      id: permissionId,
      rpcId,
      kind: "question",
      transport: "elicitation",
      questions,
    });
    if (this.autonomousTurn) {
      this.syncAutonomousToolStallGuard(this.autonomousTurn);
    }

    this.emitQuestionPermission(permissionId, questions, params.message);
  }

  private emitQuestionPermission(
    permissionId: string,
    questions: ParsedElicitationQuestion[],
    title?: string,
  ): void {
    this.options.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id: permissionId,
        name: "ask_question",
        kind: "question",
        ...(title ? { title } : {}),
        input: {
          questions: questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options,
            multiSelect: question.multiSelect,
            allowOther: question.allowOther,
            allowEmpty: question.allowEmpty,
          })),
        },
      },
    });
  }

  private shouldAutoApproveTool(
    toolCall: AcpToolCallPayload,
    detail: ProviderToolCallDetail,
  ): boolean {
    if (this.mode === "full-access") return true;
    if (this.isSessionImageRead(toolCall, detail)) return true;
    if (this.mode === "accept-edits" && isEditOrReadTool(toolCall)) return true;
    return false;
  }

  private isSessionImageRead(
    toolCall: AcpToolCallPayload,
    detail: ProviderToolCallDetail,
  ): boolean {
    const imagesDir = this.files.directoryPath;
    if (!imagesDir) return false;
    if (!isNativeReadTool(toolCall)) return false;
    const targets = extractTargetPaths(toolCall, detail);
    if (targets.length === 0) return false;
    const resolvedImagesDir = path.resolve(imagesDir);
    return targets.every((target) => {
      const resolvedTarget = path.resolve(target);
      return (
        resolvedTarget === resolvedImagesDir ||
        resolvedTarget.startsWith(`${resolvedImagesDir}${path.sep}`)
      );
    });
  }

  private autoApproveEligiblePendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.kind !== "tool") continue;
      if (!this.shouldAutoApproveTool(pending.toolCall, pending.detail)) continue;
      this.pendingPermissions.delete(id);
      const allowOption = selectPermissionOption(pending.options, { behavior: "allow" });
      this.driver?.respond(
        pending.rpcId,
        allowOption
          ? { outcome: { outcome: "selected", optionId: allowOption.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
      this.options.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: id,
      });
    }
    if (this.autonomousTurn) {
      this.syncAutonomousToolStallGuard(this.autonomousTurn);
      this.scheduleAutonomousSettleCheck();
    }
  }

  private cancelAllPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      if (pending.kind === "tool" || pending.transport === "permission") {
        this.driver?.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
      } else {
        this.driver?.respond(pending.rpcId, { action: "cancel" });
      }
      this.options.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: id,
      });
    }
  }

  private resetTurnState(): void {
    this.chunkIds.clear();
    this.chunkTexts.clear();
    this.chunkEpoch = 0;
    this.turnTools.clear();
    this.foregroundTranscriptTools.length = 0;
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
    if (messageId) {
      this.chunkIds.delete(kind);
      return this.chunkEpoch > 0
        ? `${kind}:${messageId}:${this.chunkEpoch}`
        : `${kind}:${messageId}`;
    }
    let existing = this.chunkIds.get(kind);
    if (!existing) {
      existing = `item-${++this.itemSeq}`;
      this.chunkIds.set(kind, existing);
    }
    return existing;
  }

  private currentPersistence(): ProviderPersistence | undefined {
    return this.conversationId
      ? { version: 1, data: { conversationId: this.conversationId } }
      : this.options.persistence;
  }

  private emitConfig(): void {
    const catalog = this.options.catalog();
    this.options.emit({
      type: "session.config",
      sessionId: this.id,
      config: {
        ...(this.model ? { model: this.model } : {}),
        mode: this.mode,
        models: catalog.models,
        modes: catalog.modes,
        thinkingOptions: catalog.thinkingOptions ?? [],
        settings: [],
      },
    });
  }

  private filterPostTurnCatchupUpdate(update: AcpSessionUpdate): AcpSessionUpdate | null {
    if (this.replayWindow !== null) return update;
    if (update.sessionUpdate === "user_message_chunk") {
      this.releasePostTurnCatchupFence();
      return update;
    }
    if (this.awaitingPostTurnCatchupEcho) {
      return null;
    }
    if (
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      this.synthesizedWakeupToolIds.has(update.toolCallId)
    ) {
      return null;
    }
    if (!this.filteringSlashPostTurnCatchup || this.turn === null) {
      return update;
    }
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update" ||
      update.sessionUpdate === "usage_update"
    ) {
      return null;
    }
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk"
    ) {
      return update;
    }
    return this.filterPreEchoWakeupChunk(update);
  }

  private filterPreEchoWakeupChunk(
    update: Extract<
      AcpSessionUpdate,
      { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" }
    >,
  ): AcpSessionUpdate | null {
    if (update.content.type !== "text" || !update.content.text) return update;
    const bufferKey = `${update.sessionUpdate}:${update.messageId ?? "default"}`;
    const previousBuffer = this.catchupChunkBuffers.get(bufferKey) ?? "";

    if (previousBuffer.length === 0 && update.content.text.trim().length === 0) {
      return null;
    }

    const candidates =
      update.sessionUpdate === "agent_thought_chunk"
        ? this.unstreamedWakeupThoughts
        : this.unstreamedWakeupMessages;
    if (candidates.length === 0) {
      this.releasePostTurnCatchupFence();
      return update;
    }

    const combined = `${previousBuffer}${update.content.text}`;

    if (matchesRecordedWakeupPrefix(candidates, combined)) {
      if (consumeExactWakeupMatch(candidates, combined)) {
        this.catchupChunkBuffers.delete(bufferKey);
      } else {
        this.catchupChunkBuffers.set(bufferKey, combined);
      }
      return null;
    }

    this.catchupChunkBuffers.delete(bufferKey);
    this.releasePostTurnCatchupFence();
    return {
      ...update,
      content: { ...update.content, text: combined },
    };
  }

  private armPostTurnCatchupFence(isSlashPrompt: boolean): void {
    this.catchupChunkBuffers.clear();
    if (!this.hasUnstreamedPostTurnSteps) {
      this.releasePostTurnCatchupFence();
      return;
    }
    this.hasUnstreamedPostTurnSteps = false;
    if (isSlashPrompt) {
      this.awaitingPostTurnCatchupEcho = false;
      this.filteringSlashPostTurnCatchup = true;
    } else {
      this.awaitingPostTurnCatchupEcho = true;
      this.filteringSlashPostTurnCatchup = false;
      this.unstreamedWakeupThoughts.length = 0;
      this.unstreamedWakeupMessages.length = 0;
    }
  }

  private releasePostTurnCatchupFence(): void {
    this.awaitingPostTurnCatchupEcho = false;
    this.filteringSlashPostTurnCatchup = false;
    this.unstreamedWakeupThoughts.length = 0;
    this.unstreamedWakeupMessages.length = 0;
    this.catchupChunkBuffers.clear();
  }

  private clearPostTurnCatchupState(): void {
    this.hasUnstreamedPostTurnSteps = false;
    this.releasePostTurnCatchupFence();
    this.synthesizedWakeupToolIds.clear();
  }

  private async retireDriver(): Promise<void> {
    this.stopRootMonitor();
    this.driverHasStartedPrompt = false;
    this.clearPostTurnCatchupState();
    this.driverInitPromise = null;
    this.activeBackgroundTasks.clear();
    this.subagents.settleAllRunning("canceled");
    const driver = this.driver;
    this.driver = null;
    if (driver) await driver.stop();
  }
}

function matchesRecordedWakeupPrefix(candidates: readonly string[], accumulated: string): boolean {
  const trimmed = accumulated.trim();
  return candidates.some(
    (candidate) =>
      candidate.startsWith(accumulated) ||
      (trimmed.length > 0 && candidate.trim().startsWith(trimmed)),
  );
}

function isSlashCommandPromptText(nativeText: string): boolean {
  return /^\/[a-zA-Z0-9_:-]+(?:\s|$)/.test(nativeText.trimStart());
}

function consumeExactWakeupMatch(candidates: string[], accumulated: string): boolean {
  const trimmed = accumulated.trim();
  const index = candidates.findIndex(
    (candidate) =>
      candidate === accumulated || (trimmed.length > 0 && candidate.trim() === trimmed),
  );
  if (index < 0) return false;
  candidates.splice(index, 1);
  return true;
}

function parsePersistenceId(persistence: ProviderPersistence | undefined): string | null {
  if (!persistence) return null;
  const parsed = persistenceSchema.safeParse(persistence.data);
  if (!parsed.success) {
    throw new AntigravityError(
      "Invalid Antigravity session persistence state",
      "INVALID_PERSISTENCE",
    );
  }
  return parsed.data.conversationId ?? parsed.data.sessionId ?? null;
}

function toAcpMcpServers(
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>> | undefined,
): Array<Record<string, unknown>> {
  if (!mcpServers) return [];
  return Object.entries(mcpServers).map(([name, server]) => {
    if (server.type === "stdio") {
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
          name: envName,
          value,
        })),
      };
    }
    return {
      type: server.type,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([headerName, value]) => ({
        name: headerName,
        value,
      })),
    };
  });
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
