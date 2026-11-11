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
import { DEFAULT_MODE, validateSelection, type AntigravityModeId } from "./catalog.js";
import {
  accountLocatorKey,
  resolveAntigravityDataDir,
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
  extractTargetPaths,
  inferToolName,
  isEditOrReadTool,
  isNativeReadTool,
  mapAcpToolCall,
  mapAcpToolDetail,
  mergeAcpToolCall,
} from "./timeline.js";
import {
  computeStepContextWindowTokens,
  extractTranscriptToolResultOutput,
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
  parseElicitationQuestions,
  persistenceSchema,
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
const AUTONOMOUS_ACP_SETTLE_MS = 320;
const AUTONOMOUS_TRANSCRIPT_SETTLE_MS = 120;
const AUTONOMOUS_PLANNER_TIMEOUT_MS = 90_000;

interface ActiveTurn {
  id: string;
  interrupted: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

interface AutonomousTurn {
  id: string;
  receivedAcpUpdates: boolean;
  awaitingPlannerResponse: boolean;
  pendingTranscriptTools: AcpToolCallPayload[];
  settleTimer: NodeJS.Timeout | null;
  plannerTimeoutTimer: NodeJS.Timeout | null;
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
      questions: ParsedElicitationQuestion[];
    };

export class Session {
  private readonly id: string;
  private readonly files = new PromptFiles();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly chunkIds = new Map<string, string>();
  private readonly chunkTexts = new Map<string, string>();
  private readonly turnTools = new Map<string, AcpToolCallPayload>();
  private readonly activeBackgroundTasks = new Map<string, { persistent: boolean }>();
  private readonly seenRootSteps = new Set<number>();
  private readonly foregroundTranscriptTools: AcpToolCallPayload[] = [];
  private readonly subagents: SubagentManager;
  private readonly dataDir: string;
  private readonly locatorId: string;

  private driver: DriverProcess | null = null;
  private rootTranscriptReader: JsonlTranscriptReader | null = null;
  private rootMonitorTimer: NodeJS.Timeout | null = null;
  private rootTranscriptSyncPromise: Promise<void> | null = null;
  private rootTranscriptSyncRequested = false;
  private latestContextWindowUsedTokens: number | undefined;
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
  private turnSeq = 0;
  private wakeupSeq = 0;
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
      this.mode = changes.mode as AntigravityModeId;
      this.autoApproveEligiblePendingPermissions();
    }
    if (changes.model !== undefined) {
      await this.applyModelChange(changes.model);
    }
    this.emitConfig();
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
        this.model = result.models?.currentModelId ?? targetModel;
        this.modelDirty = false;
        return;
      }
      await this.retireDriver();
      this.model = null;
      this.modelDirty = false;
      return;
    }

    this.model = targetModel;
    this.modelDirty = true;
  }

  private resolveDefaultModel(): string | null {
    return this.defaultModel ?? this.options.catalog().models[0]?.id ?? null;
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.clearPendingPermissions) {
      this.cancelAllPermissions();
    }
    if (this.autonomousTurn) {
      await this.trySettleAutonomousTurn(this.autonomousTurn);
    }
    if (this.turn || this.autonomousTurn) {
      throw new AntigravityError("Antigravity already has an active turn", "TURN_ACTIVE");
    }
    const encoded = await this.files.encode(prompt);
    const driver = await this.ensureDriver();
    if (!this.conversationId) {
      throw new AntigravityError(
        "Antigravity ACP session has no active conversation ID",
        "PROCESS_FAILED",
      );
    }

    await this.syncRootTranscript();

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
    this.resetTurnState();
    this.ensureRootMonitor();

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
    this.options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId,
      state: "started",
    });

    void this.executeTurn(driver, turn, encoded.nativeText);
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
      this.scheduleAutonomousSettleCheck();
    }
  }

  async interrupt(): Promise<void> {
    const activeTurn = this.turn;
    const driver = this.driver;
    if (!activeTurn && !this.autonomousTurn) return;

    this.cancelAllPermissions();

    if (!activeTurn && this.autonomousTurn) {
      if (driver && this.conversationId) {
        driver.notify("session/cancel", { sessionId: this.conversationId });
      }
      this.settleAutonomousTurn("canceled");
      return;
    }

    if (!activeTurn || !driver) return;
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
    }
    return payload;
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

  private async ensureDriver(): Promise<DriverProcess> {
    if (this.driver?.isAlive) {
      await this.syncDirtyModel(this.driver);
      return this.driver;
    }

    const driver = this.spawnDriver();
    this.driver = driver;

    try {
      await this.initializeAcpSession(driver);
      this.bindRootTranscriptReader();
      this.ensureRootMonitor();
      return driver;
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
        additionalDirectories: this.files.directoryPath ? [this.files.directoryPath] : [],
      },
      {
        onNotification: (method, params) => this.handleNotification(driver, method, params),
        onRequest: (id, method, params) => this.handleServerRequest(driver, id, method, params),
        onExit: (failure) => {
          if (this.driver !== driver) return;
          this.driver = null;
          this.stopRootMonitor();
          this.activeBackgroundTasks.clear();
          if (!this.turn && this.autonomousTurn) {
            this.cancelAllPermissions();
            this.settleAutonomousTurn("failed", toProviderError(failure));
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
    this.model = result.models?.currentModelId ?? targetModel;
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
      this.model = modelResult.models?.currentModelId ?? targetModel;
    } else if (reportedModel) {
      this.model = reportedModel;
    }
    this.modelDirty = false;
  }

  private async openOrLoadAcpSession(driver: DriverProcess) {
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
        return await driver.requestInit(
          "session/load",
          {
            sessionId: this.conversationId,
            cwd: this.options.config.cwd,
            mcpServers,
            ...(meta ? { _meta: meta } : {}),
          },
          acpSessionResultSchema,
        );
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

  private bindRootTranscriptReader(): void {
    if (!this.conversationId) return;
    const expectedPath = resolveConversationTranscriptPath(this.dataDir, this.conversationId);
    if (!this.rootTranscriptReader || this.rootTranscriptReader.filePath !== expectedPath) {
      this.rootTranscriptReader = new JsonlTranscriptReader(expectedPath);
      this.seenRootSteps.clear();
    }
  }

  private async initializeRootTranscriptCursor(): Promise<void> {
    this.bindRootTranscriptReader();
    if (!this.rootTranscriptReader) return;
    const existingSteps = await this.rootTranscriptReader.readNewSteps({
      allowTrailingWithoutNewline: true,
    });
    for (const step of existingSteps) {
      this.seenRootSteps.add(step.stepIndex);
      const contextUsed = computeStepContextWindowTokens(step);
      if (contextUsed !== undefined) {
        this.latestContextWindowUsedTokens = contextUsed;
      }
    }
  }

  private ensureRootMonitor(): void {
    if (this.rootMonitorTimer || this.closed || !this.driver?.isAlive) return;
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
            this.seenRootSteps.add(step.stepIndex);
            await this.applyRootTranscriptStep(step);
          }
        }
      } finally {
        this.rootTranscriptSyncPromise = null;
      }
    })();
    await this.rootTranscriptSyncPromise;
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

    if (step.type === "PLANNER_RESPONSE" && step.toolCalls.length > 0) {
      step.toolCalls.forEach((call, index) => {
        const payload: AcpToolCallPayload = {
          toolCallId: call.id ?? `fg-tool-${step.stepIndex}-${index}`,
          title: call.name,
          status: "in_progress",
          rawInput: call.args,
        };
        this.foregroundTranscriptTools.push(payload);
        this.inspectToolSideEffects(payload);
      });
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
      this.inspectToolSideEffects(completed);
    }
  }

  private async applyPostTurnTranscriptStep(
    step: TranscriptStep,
    wakeup: SystemWakeupInfo | null,
  ): Promise<void> {
    if (wakeup) {
      this.acknowledgeWakeupTask(wakeup);
      await this.subagents.handleParentWakeupSender(wakeup.sender);
      const auto = this.ensureAutonomousTurn("transcript");
      auto.awaitingPlannerResponse = true;
      this.armAutonomousPlannerTimeout(auto);
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
    auto.awaitingPlannerResponse = false;
    this.clearAutonomousPlannerTimeout(auto);

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

    if (step.status === "CANCELED" || step.status === "CANCELLED") {
      this.settleAutonomousTurn("canceled");
      return;
    }

    this.scheduleAutonomousSettleCheck(AUTONOMOUS_TRANSCRIPT_SETTLE_MS);
  }

  private emitAutonomousPlannerTextAndUsage(auto: AutonomousTurn, step: TranscriptStep): void {
    if (step.thinking?.trim()) {
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
    }
    return payload;
  }

  private enqueueAutonomousToolCalls(auto: AutonomousTurn, step: TranscriptStep): void {
    auto.awaitingPlannerResponse = true;
    this.armAutonomousPlannerTimeout(auto);
    step.toolCalls.forEach((call, index) => {
      const payload: AcpToolCallPayload = {
        toolCallId: call.id ?? `wakeup-tool-${step.stepIndex}-${index}`,
        title: call.name,
        status: "in_progress",
        rawInput: call.args,
      };
      auto.pendingTranscriptTools.push(payload);
      if (!auto.receivedAcpUpdates) {
        this.options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: mapAcpToolCall(payload),
          ...(step.createdAt ? { timestamp: step.createdAt } : {}),
        });
      }
      this.inspectToolSideEffects(payload);
    });
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
    const pending = auto.pendingTranscriptTools.shift()!;
    const output = extractTranscriptToolResultOutput(step);
    const isFailed = step.status === "ERROR";
    const updatedPayload: AcpToolCallPayload = {
      ...pending,
      status: isFailed ? "failed" : "completed",
      ...(output !== undefined ? { rawOutput: isFailed ? { error: output } : { output } } : {}),
    };
    if (!auto.receivedAcpUpdates) {
      this.options.emit({
        type: "timeline.item",
        sessionId: this.id,
        item: mapAcpToolCall(updatedPayload),
        ...(step.createdAt ? { timestamp: step.createdAt } : {}),
      });
    }
    this.inspectToolSideEffects(updatedPayload);
    this.scheduleAutonomousSettleCheck();
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
    // Also clear any synthetic one-shot schedule:<toolCallId> if a schedule/timer wakeup arrived
    if (
      wakeup.sender === "scheduler" ||
      wakeup.sender?.includes("schedule") ||
      (candidates.length === 0 && this.activeBackgroundTasks.size > 0)
    ) {
      for (const [taskId, entry] of this.activeBackgroundTasks) {
        if (taskId.startsWith("schedule:") && !entry.persistent) {
          this.activeBackgroundTasks.delete(taskId);
          break;
        }
      }
    }
  }

  private ensureAutonomousTurn(source: "acp" | "transcript"): AutonomousTurn {
    if (this.autonomousTurn) return this.autonomousTurn;
    this.resetTurnState();
    const turnId = `wakeup-${++this.wakeupSeq}`;
    const auto: AutonomousTurn = {
      id: turnId,
      receivedAcpUpdates: source === "acp",
      awaitingPlannerResponse: false,
      pendingTranscriptTools: [],
      settleTimer: null,
      plannerTimeoutTimer: null,
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

  private armAutonomousPlannerTimeout(auto: AutonomousTurn): void {
    this.clearAutonomousPlannerTimeout(auto);
    auto.plannerTimeoutTimer = setTimeout(() => {
      if (this.autonomousTurn !== auto) return;
      auto.awaitingPlannerResponse = false;
      this.scheduleAutonomousSettleCheck(50);
    }, AUTONOMOUS_PLANNER_TIMEOUT_MS);
    auto.plannerTimeoutTimer.unref?.();
  }

  private clearAutonomousPlannerTimeout(auto: AutonomousTurn): void {
    if (auto.plannerTimeoutTimer) {
      clearTimeout(auto.plannerTimeoutTimer);
      auto.plannerTimeoutTimer = null;
    }
  }

  private clearAutonomousTimers(auto: AutonomousTurn): void {
    if (auto.settleTimer) {
      clearTimeout(auto.settleTimer);
      auto.settleTimer = null;
    }
    this.clearAutonomousPlannerTimeout(auto);
  }

  private scheduleAutonomousSettleCheck(delayMs = AUTONOMOUS_ACP_SETTLE_MS): void {
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

  private inspectToolSideEffects(tool: AcpToolCallPayload): void {
    const launchInfo = extractSubagentLaunchInfo(tool, this.options.config.cwd);
    if (launchInfo) {
      this.subagents.registerLaunch(this.id, launchInfo);
    }
    const control = extractSubagentControlAction(tool);
    if (control) {
      this.subagents.applyControlAction(control);
    }
    const bgLaunch = extractBackgroundTaskLaunch(tool);
    if (bgLaunch) {
      this.activeBackgroundTasks.set(bgLaunch.taskId, { persistent: bgLaunch.persistent });
    }
    const killedTask = extractBackgroundTaskKill(tool);
    if (killedTask) {
      this.activeBackgroundTasks.delete(killedTask);
    }
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
      this.options.emit({
        type: "session.commands",
        sessionId: this.id,
        commands: this.availableCommands,
      });
      return;
    }

    if (this.replayWindow === "skip") return;

    const isPostTurnLive = this.turn === null && this.replayWindow === null;

    if (update.sessionUpdate === "usage_update") {
      if (isPostTurnLive) {
        const auto = this.ensureAutonomousTurn("acp");
        auto.receivedAcpUpdates = true;
        this.scheduleAutonomousSettleCheck();
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
        const auto = this.ensureAutonomousTurn("acp");
        auto.receivedAcpUpdates = true;
        this.scheduleAutonomousSettleCheck();
      }
      this.applyChunkUpdate(update);
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (isPostTurnLive) {
        const auto = this.ensureAutonomousTurn("acp");
        auto.receivedAcpUpdates = true;
        this.scheduleAutonomousSettleCheck();
      }
      this.chunkIds.clear();
      this.chunkEpoch += 1;
      const merged = mergeAcpToolCall(this.turnTools.get(update.toolCallId), update);
      this.turnTools.set(update.toolCallId, merged);
      this.inspectToolSideEffects(merged);
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
    const activeTurnId = this.turn?.id ?? this.autonomousTurn?.id;
    const cachedInputTokens = update.cachedInputTokens ?? update.cachedReadTokens;
    this.options.emit({
      type: "session.usage",
      sessionId: this.id,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      usage: {
        ...(update.inputTokens !== undefined ? { inputTokens: update.inputTokens } : {}),
        ...(update.outputTokens !== undefined ? { outputTokens: update.outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(update.used !== undefined ? { contextWindowUsedTokens: update.used } : {}),
        ...(update.size !== undefined ? { contextWindowMaxTokens: update.size } : {}),
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

    if (this.turn === null && this.replayWindow === null) {
      this.ensureAutonomousTurn(isRootSession ? "acp" : "transcript");
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

  private handleElicitationRequest(rpcId: string | number, params: AcpElicitationParams): void {
    if (this.turn === null && this.replayWindow === null) {
      const isRootSession =
        !this.conversationId || !params.sessionId || params.sessionId === this.conversationId;
      this.ensureAutonomousTurn(isRootSession ? "acp" : "transcript");
    }

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
      this.scheduleAutonomousSettleCheck();
    }
  }

  private cancelAllPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      if (pending.kind === "tool") {
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

  private async retireDriver(): Promise<void> {
    this.stopRootMonitor();
    const driver = this.driver;
    this.driver = null;
    if (driver) await driver.stop();
  }
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

function selectPermissionOption(
  options: AcpPermissionOption[],
  response: ProviderPermissionResponse,
): AcpPermissionOption | undefined {
  if (response.selectedActionId) {
    const exact = options.find((option) => option.optionId === response.selectedActionId);
    if (exact) return exact;
  }
  if (response.behavior === "allow") {
    return (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind.startsWith("allow")) ??
      options.find((option) => /allow/i.test(option.optionId))
    );
  }
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind.startsWith("reject")) ??
    options.find((option) => /deny|reject/i.test(option.optionId))
  );
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
