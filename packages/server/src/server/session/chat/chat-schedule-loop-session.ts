import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import {
  ChatServiceError,
  type FileBackedChatService,
  parseMentionAgentIds,
} from "../../chat/chat-service.js";
import { notifyChatMentions, prepareChatMentionFanout } from "../../chat/chat-mentions.js";
import type { LoopService } from "../../loop-service.js";
import type { ScheduleService } from "../../schedule/service.js";

/**
 * The collaborators a chat command reaches that are NOT part of the chat/schedule/loop
 * domain: the agent roster reads and the agent-message send used only by chat/post
 * mention fanout. The Session shell owns the agent lifecycle; this subsystem orchestrates
 * a notification through it but does not own it.
 */
export interface ChatScheduleLoopSessionHost {
  emit(msg: SessionOutboundMessage): void;
  listStoredAgents(): Promise<StoredAgentRecord[]>;
  listLiveAgents(): ManagedAgent[];
  resolveAgentIdentifier(
    identifier: string,
  ): Promise<{ ok: true; agentId: string } | { ok: false; error: string }>;
  sendAgentMessage(agentId: string, text: string): Promise<void>;
}

export interface ChatScheduleLoopSessionOptions {
  host: ChatScheduleLoopSessionHost;
  chatService: FileBackedChatService;
  scheduleService: ScheduleService;
  loopService: LoopService;
  clientId: string;
  logger: pino.Logger;
}

/**
 * A client's chat, schedule, and loop request surface. The three families are the
 * least-coupled in the session: each is a stateless request/response over its own
 * service (chat rooms, cron routines, autonomous loops), with no shared observer,
 * git, or voice state and no subscriptions to tear down. They live in one subsystem
 * because they are dispatched together — schedule/* was historically reached through
 * the chat dispatcher's fall-through arm. The three rpc-error emitters stay separate:
 * they differ by default code, and only the chat one reads ChatServiceError.code.
 */
export class ChatScheduleLoopSession {
  private readonly host: ChatScheduleLoopSessionHost;
  private readonly chatService: FileBackedChatService;
  private readonly scheduleService: ScheduleService;
  private readonly loopService: LoopService;
  private readonly clientId: string;
  private readonly logger: pino.Logger;

  constructor(options: ChatScheduleLoopSessionOptions) {
    this.host = options.host;
    this.chatService = options.chatService;
    this.scheduleService = options.scheduleService;
    this.loopService = options.loopService;
    this.clientId = options.clientId;
    this.logger = options.logger;
  }

  private emitChatRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : "Chat request failed";
    const code = error instanceof ChatServiceError ? error.code : "chat_request_failed";
    this.logger.error({ err: error, requestType: request.type }, "Chat request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code,
      },
    });
  }

  async handleChatCreateRequest(
    request: Extract<SessionInboundMessage, { type: "chat/create" }>,
  ): Promise<void> {
    try {
      const room = await this.chatService.createRoom({
        name: request.name,
        purpose: request.purpose,
      });
      this.host.emit({
        type: "chat/create/response",
        payload: {
          requestId: request.requestId,
          room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatListRequest(
    request: Extract<SessionInboundMessage, { type: "chat/list" }>,
  ): Promise<void> {
    try {
      const rooms = await this.chatService.listRooms();
      this.host.emit({
        type: "chat/list/response",
        payload: {
          requestId: request.requestId,
          rooms,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatInspectRequest(
    request: Extract<SessionInboundMessage, { type: "chat/inspect" }>,
  ): Promise<void> {
    try {
      const result = await this.chatService.inspectRoom({
        room: request.room,
      });
      this.host.emit({
        type: "chat/inspect/response",
        payload: {
          requestId: request.requestId,
          room: result.room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "chat/delete" }>,
  ): Promise<void> {
    try {
      const result = await this.chatService.deleteRoom({
        room: request.room,
      });
      this.host.emit({
        type: "chat/delete/response",
        payload: {
          requestId: request.requestId,
          room: result.room,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatPostRequest(
    request: Extract<SessionInboundMessage, { type: "chat/post" }>,
  ): Promise<void> {
    try {
      const authorAgentId = request.authorAgentId?.trim() || this.clientId;
      const mentionAgentIds = parseMentionAgentIds(request.body);
      const storedAgents = await this.host.listStoredAgents();
      const liveAgents = this.host.listLiveAgents();
      const fanout = await prepareChatMentionFanout({
        authorAgentId,
        mentionAgentIds,
        storedAgents,
        liveAgents,
        listRoomPosterAgentIds: () =>
          this.chatService.listRoomPosterAgentIds({ room: request.room }),
      });
      if (!fanout.ok) {
        throw new ChatServiceError("chat_mention_fanout_limit_exceeded", fanout.error);
      }
      const message = await this.chatService.dispatchMessage({
        room: request.room,
        authorAgentId,
        body: request.body,
        replyToMessageId: request.replyToMessageId,
      });
      this.host.emit({
        type: "chat/post/response",
        payload: {
          requestId: request.requestId,
          message,
          error: null,
        },
      });
      void notifyChatMentions({
        room: request.room,
        authorAgentId,
        body: request.body,
        mentionAgentIds: message.mentionAgentIds,
        logger: this.logger,
        storedAgents,
        liveAgents,
        prepared: fanout.prepared,
        resolveAgentIdentifier: (identifier) => this.host.resolveAgentIdentifier(identifier),
        sendAgentMessage: (agentId, text) => this.host.sendAgentMessage(agentId, text),
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatReadRequest(
    request: Extract<SessionInboundMessage, { type: "chat/read" }>,
  ): Promise<void> {
    try {
      const messages = await this.chatService.readMessages({
        room: request.room,
        limit: request.limit,
        since: request.since,
        authorAgentId: request.authorAgentId,
      });
      this.host.emit({
        type: "chat/read/response",
        payload: {
          requestId: request.requestId,
          messages,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  async handleChatWaitRequest(
    request: Extract<SessionInboundMessage, { type: "chat/wait" }>,
  ): Promise<void> {
    try {
      const messages = await this.chatService.waitForMessages({
        room: request.room,
        afterMessageId: request.afterMessageId,
        timeoutMs: request.timeoutMs,
      });
      this.host.emit({
        type: "chat/wait/response",
        payload: {
          requestId: request.requestId,
          messages,
          timedOut: messages.length === 0,
          error: null,
        },
      });
    } catch (error) {
      this.emitChatRpcError(request, error);
    }
  }

  private toScheduleSummary(
    schedule: Awaited<ReturnType<ScheduleService["inspect"]>>,
  ): Extract<
    SessionOutboundMessage,
    { type: "schedule/list/response" }
  >["payload"]["schedules"][number] {
    const { runs: _runs, ...summary } = schedule;
    return summary;
  }

  private emitScheduleRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type:
          | "schedule/create"
          | "schedule/list"
          | "schedule/inspect"
          | "schedule/logs"
          | "schedule/pause"
          | "schedule/resume"
          | "schedule/delete"
          | "schedule/run-once"
          | "schedule/update";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Schedule request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "schedule_request_failed",
      },
    });
  }

  async handleScheduleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/create" }>,
  ): Promise<void> {
    try {
      const target =
        request.target.type === "self"
          ? { type: "agent" as const, agentId: request.target.agentId }
          : request.target;
      const schedule = await this.scheduleService.create({
        prompt: request.prompt,
        name: request.name,
        cadence: request.cadence,
        target,
        maxRuns: request.maxRuns,
        expiresAt: request.expiresAt,
        runOnCreate: request.runOnCreate,
      });
      this.host.emit({
        type: "schedule/create/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleListRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/list" }>,
  ): Promise<void> {
    try {
      const schedules = await this.scheduleService.list();
      this.host.emit({
        type: "schedule/list/response",
        payload: {
          requestId: request.requestId,
          schedules: schedules.map((schedule) => this.toScheduleSummary(schedule)),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleInspectRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/inspect" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.inspect(request.scheduleId);
      this.host.emit({
        type: "schedule/inspect/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleLogsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/logs" }>,
  ): Promise<void> {
    try {
      const runs = await this.scheduleService.logs(request.scheduleId);
      this.host.emit({
        type: "schedule/logs/response",
        payload: {
          requestId: request.requestId,
          runs,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleSchedulePauseRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/pause" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.pause(request.scheduleId);
      this.host.emit({
        type: "schedule/pause/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleResumeRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/resume" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.resume(request.scheduleId);
      this.host.emit({
        type: "schedule/resume/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/delete" }>,
  ): Promise<void> {
    try {
      await this.scheduleService.delete(request.scheduleId);
      this.host.emit({
        type: "schedule/delete/response",
        payload: {
          requestId: request.requestId,
          scheduleId: request.scheduleId,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleRunOnceRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/run-once" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.runOnce(request.scheduleId);
      this.host.emit({
        type: "schedule/run-once/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/update" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.update({
        id: request.scheduleId,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(request.cadence !== undefined ? { cadence: request.cadence } : {}),
        ...(request.newAgentConfig !== undefined ? { newAgentConfig: request.newAgentConfig } : {}),
        ...(request.maxRuns !== undefined ? { maxRuns: request.maxRuns } : {}),
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      });
      this.host.emit({
        type: "schedule/update/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  private emitLoopRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type: "loop/run" | "loop/list" | "loop/inspect" | "loop/logs" | "loop/stop";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Loop request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "loop_request_failed",
      },
    });
  }

  async handleLoopRunRequest(
    request: Extract<SessionInboundMessage, { type: "loop/run" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.runLoop({
        prompt: request.prompt,
        cwd: request.cwd,
        provider: request.provider,
        model: request.model,
        modeId: request.modeId,
        workerProvider: request.workerProvider,
        workerModel: request.workerModel,
        verifierProvider: request.verifierProvider,
        verifierModel: request.verifierModel,
        verifierModeId: request.verifierModeId,
        verifyPrompt: request.verifyPrompt,
        verifyChecks: request.verifyChecks,
        archive: request.archive,
        name: request.name,
        sleepMs: request.sleepMs,
        maxIterations: request.maxIterations,
        maxTimeMs: request.maxTimeMs,
      });
      this.host.emit({
        type: "loop/run/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  async handleLoopListRequest(
    request: Extract<SessionInboundMessage, { type: "loop/list" }>,
  ): Promise<void> {
    try {
      const loops = await this.loopService.listLoops();
      this.host.emit({
        type: "loop/list/response",
        payload: {
          requestId: request.requestId,
          loops,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  async handleLoopInspectRequest(
    request: Extract<SessionInboundMessage, { type: "loop/inspect" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.inspectLoop(request.id);
      this.host.emit({
        type: "loop/inspect/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  async handleLoopLogsRequest(
    request: Extract<SessionInboundMessage, { type: "loop/logs" }>,
  ): Promise<void> {
    try {
      const result = await this.loopService.getLoopLogs(request.id, request.afterSeq ?? 0);
      this.host.emit({
        type: "loop/logs/response",
        payload: {
          requestId: request.requestId,
          loop: result.loop,
          entries: result.entries,
          nextCursor: result.nextCursor,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }

  async handleLoopStopRequest(
    request: Extract<SessionInboundMessage, { type: "loop/stop" }>,
  ): Promise<void> {
    try {
      const loop = await this.loopService.stopLoop(request.id);
      this.host.emit({
        type: "loop/stop/response",
        payload: {
          requestId: request.requestId,
          loop,
          error: null,
        },
      });
    } catch (error) {
      this.emitLoopRpcError(request, error);
    }
  }
}
