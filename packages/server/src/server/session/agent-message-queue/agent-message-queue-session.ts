import { getErrorMessageOr } from "@getpaseo/protocol/error-utils";
import {
  normalizeAgentAttachments,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../../messages.js";
import type { AgentMessageQueueController } from "../../agent-message-queue.js";

type QueueRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "queue.agent_message.enqueue.request"
      | "queue.agent_message.list.request"
      | "queue.agent_message.cancel.request"
      | "queue.agent_message.dispatch.request";
  }
>;

export type AgentIdentifierResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

export interface AgentMessageQueueSessionOptions {
  host: {
    emit(message: SessionOutboundMessage, source?: object): void;
    resolveAgentIdentifier(identifier: string): Promise<AgentIdentifierResolution>;
  };
  queue?: AgentMessageQueueController;
}

/**
 * Owns the queue RPC surface for one client session: request normalization,
 * identifier resolution, response envelopes, and source-aware delivery. The
 * queue itself remains daemon-global and is injected by the WebSocket server.
 */
export class AgentMessageQueueSession {
  private readonly host: AgentMessageQueueSessionOptions["host"];
  private readonly queue: AgentMessageQueueController | null;

  constructor(options: AgentMessageQueueSessionOptions) {
    this.host = options.host;
    this.queue = options.queue ?? null;
  }

  dispatch(message: SessionInboundMessage, source?: object): Promise<void> | undefined {
    switch (message.type) {
      case "queue.agent_message.enqueue.request":
        return this.handleEnqueue(message, source);
      case "queue.agent_message.list.request":
        return this.handleList(message, source);
      case "queue.agent_message.cancel.request":
        return this.handleCancel(message, source);
      case "queue.agent_message.dispatch.request":
        return this.handleDispatch(message, source);
      default:
        return undefined;
    }
  }

  private requireQueue(): AgentMessageQueueController {
    if (!this.queue) {
      throw new Error("Agent message queue is unavailable");
    }
    return this.queue;
  }

  private async handleEnqueue(
    message: Extract<QueueRequest, { type: "queue.agent_message.enqueue.request" }>,
    source?: object,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(message.agentId);
    if (!resolved.ok) {
      this.host.emit(
        {
          type: "queue.agent_message.enqueue.response",
          payload: {
            requestId: message.requestId,
            agentId: message.agentId,
            accepted: false,
            message: null,
            error: resolved.error,
          },
        },
        source,
      );
      return;
    }

    try {
      const queued = await this.requireQueue().enqueue({
        agentId: resolved.agentId,
        text: message.text,
        messageId: message.messageId,
        images: message.images ?? [],
        attachments: normalizeAgentAttachments(message.attachments),
      });
      this.host.emit(
        {
          type: "queue.agent_message.enqueue.response",
          payload: {
            requestId: message.requestId,
            agentId: resolved.agentId,
            accepted: true,
            message: queued,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "queue.agent_message.enqueue.response",
          payload: {
            requestId: message.requestId,
            agentId: resolved.agentId,
            accepted: false,
            message: null,
            error: getErrorMessageOr(error, "Failed to queue agent message"),
          },
        },
        source,
      );
    }
  }

  private async handleList(
    message: Extract<QueueRequest, { type: "queue.agent_message.list.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      let agentId: string | undefined;
      if (message.agentId) {
        const resolved = await this.resolveAgentIdentifier(message.agentId);
        if (!resolved.ok) {
          this.host.emit(
            {
              type: "queue.agent_message.list.response",
              payload: { requestId: message.requestId, queues: [], error: resolved.error },
            },
            source,
          );
          return;
        }
        agentId = resolved.agentId;
      }
      const queues = await this.requireQueue().list(agentId);
      this.host.emit(
        {
          type: "queue.agent_message.list.response",
          payload: { requestId: message.requestId, queues, error: null },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "queue.agent_message.list.response",
          payload: {
            requestId: message.requestId,
            queues: [],
            error: getErrorMessageOr(error, "Failed to list queued agent messages"),
          },
        },
        source,
      );
    }
  }

  private async handleCancel(
    message: Extract<QueueRequest, { type: "queue.agent_message.cancel.request" }>,
    source?: object,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(message.agentId);
    if (!resolved.ok) {
      this.emitMutationResult(message, message.agentId, false, resolved.error, source);
      return;
    }
    try {
      const removed = await this.requireQueue().cancel(resolved.agentId, message.queuedMessageId);
      this.emitMutationResult(
        message,
        resolved.agentId,
        removed,
        removed ? null : `Queued message not found: ${message.queuedMessageId}`,
        source,
      );
    } catch (error) {
      this.emitMutationResult(
        message,
        resolved.agentId,
        false,
        getErrorMessageOr(error, "Failed to cancel queued agent message"),
        source,
      );
    }
  }

  private async handleDispatch(
    message: Extract<QueueRequest, { type: "queue.agent_message.dispatch.request" }>,
    source?: object,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(message.agentId);
    if (!resolved.ok) {
      this.emitMutationResult(message, message.agentId, false, resolved.error, source);
      return;
    }
    try {
      await this.requireQueue().dispatchNow(resolved.agentId, message.queuedMessageId);
      this.emitMutationResult(message, resolved.agentId, true, null, source);
    } catch (error) {
      this.emitMutationResult(
        message,
        resolved.agentId,
        false,
        getErrorMessageOr(error, "Failed to dispatch queued agent message"),
        source,
      );
    }
  }

  private emitMutationResult(
    message: Extract<
      QueueRequest,
      {
        type: "queue.agent_message.cancel.request" | "queue.agent_message.dispatch.request";
      }
    >,
    agentId: string,
    accepted: boolean,
    error: string | null,
    source?: object,
  ): void {
    const payload = {
      requestId: message.requestId,
      agentId,
      queuedMessageId: message.queuedMessageId,
      accepted,
      error,
    };
    this.host.emit(
      message.type === "queue.agent_message.cancel.request"
        ? { type: "queue.agent_message.cancel.response", payload }
        : { type: "queue.agent_message.dispatch.response", payload },
      source,
    );
  }

  private async resolveAgentIdentifier(identifier: string): Promise<AgentIdentifierResolution> {
    try {
      return await this.host.resolveAgentIdentifier(identifier);
    } catch {
      return { ok: false, error: "Failed to resolve agent identifier" };
    }
  }
}
