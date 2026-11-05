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
import { DEFAULT_MODE, validateSelection, type AntigravityModeId } from "./catalog.js";
import { DriverProcess } from "./process.js";
import { PromptFiles } from "./prompt.js";
import {
  extractTargetPaths,
  inferToolName,
  isEditOrReadTool,
  isNativeReadTool,
  mapAcpToolCall,
  mapAcpToolDetail,
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
  type AcpElicitationParams,
  type AcpPermissionOption,
  type AcpRequestPermissionParams,
  type AcpSessionUpdate,
  type AcpToolCallPayload,
  type JsonValue,
  type ParsedElicitationQuestion,
} from "./wire.js";

const INTERRUPT_GRACE_MS = 350;

interface ActiveTurn {
  id: string;
  interrupted: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
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

  private driver: DriverProcess | null = null;
  private conversationId: string | null;
  private model: string | null;
  private defaultModel: string | null = null;
  private mode: AntigravityModeId;
  private modelDirty = false;
  private availableCommands: ProviderCommand[] = [];
  private turn: ActiveTurn | null = null;
  private shouldReplayOnLoad: boolean;
  private replayWindow: "replay" | "skip" | null = null;
  private turnSeq = 0;
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
    this.conversationId = parsePersistenceId(options.persistence);
    this.shouldReplayOnLoad =
      this.conversationId !== null && (options.history ?? "replay") === "replay";
    this.model = options.config.model ?? null;
    this.mode = (options.config.mode as AntigravityModeId | undefined) ?? DEFAULT_MODE;
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    await this.ensureDriver();
    if (this.closed) return;

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
    this.options.emit({
      type: "session.ready",
      requestId,
      sessionId: this.id,
    });
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

    if (this.driver?.isAlive && this.conversationId && !this.turn) {
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
    if (this.turn) {
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

    if (response.behavior === "deny" && response.interrupt && this.turn && this.conversationId) {
      this.turn.interrupted = true;
      this.driver?.notify("session/cancel", { sessionId: this.conversationId });
    }

    this.options.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId,
    });
  }

  async interrupt(): Promise<void> {
    const activeTurn = this.turn;
    const driver = this.driver;
    if (!activeTurn || !driver) return;
    activeTurn.interrupted = true;
    this.cancelAllPermissions();

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
    if (this.turn) this.turn.interrupted = true;
    this.cancelAllPermissions();
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
      this.turn = null;
      this.cancelAllPermissions();

      if (response.usage) {
        this.options.emit({
          type: "session.usage",
          sessionId: this.id,
          turnId: turn.id,
          usage: {
            ...(response.usage.inputTokens !== undefined
              ? { inputTokens: response.usage.inputTokens }
              : {}),
            ...(response.usage.outputTokens !== undefined
              ? { outputTokens: response.usage.outputTokens }
              : {}),
            ...(response.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: response.usage.cachedInputTokens }
              : {}),
            ...(response.usage.totalCostUsd !== undefined
              ? { totalCostUsd: response.usage.totalCostUsd }
              : {}),
          },
        });
      }

      const finalState =
        turn.interrupted || response.stopReason === "cancelled" ? "canceled" : "completed";
      this.settleTurnTools(finalState === "canceled" ? "failed" : "completed");
      this.options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: turn.id,
        state: finalState,
      });
    } catch (error) {
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
      } else {
        this.options.emit({
          type: "session.turn",
          sessionId: this.id,
          turnId: turn.id,
          state: "failed",
          error: toProviderError(error),
        });
      }
    } finally {
      turn.resolveSettled();
    }
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
        onExit: () => {
          if (this.driver === driver) this.driver = null;
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

    if (update.sessionUpdate === "usage_update") {
      this.emitUsageUpdate(update);
      return;
    }

    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      this.applyChunkUpdate(update);
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.chunkIds.clear();
      const merged = mergeAcpToolCall(this.turnTools.get(update.toolCallId), update);
      this.turnTools.set(update.toolCallId, merged);
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
    this.options.emit({
      type: "session.usage",
      sessionId: this.id,
      ...(this.turn ? { turnId: this.turn.id } : {}),
      usage: {
        ...(update.inputTokens !== undefined ? { inputTokens: update.inputTokens } : {}),
        ...(update.outputTokens !== undefined ? { outputTokens: update.outputTokens } : {}),
        ...(update.cachedInputTokens !== undefined
          ? { cachedInputTokens: update.cachedInputTokens }
          : {}),
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
    const mergedTool = mergeAcpToolCall(
      this.turnTools.get(request.toolCall.toolCallId),
      request.toolCall,
    );
    this.turnTools.set(request.toolCall.toolCallId, mergedTool);
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
    if (messageId) {
      this.chunkIds.delete(kind);
      return `${kind}:${messageId}`;
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
