import { randomUUID } from "node:crypto";
import type {
  ActiveTurnBehavior,
  QueuedAgentMessage,
  QueuedAgentMessageSummary,
} from "@getpaseo/protocol/messages";
import type { AgentStorage } from "./agent-storage.js";

export interface EnqueueAgentMessageInput {
  agentId: string;
  text: string;
  messageId?: string;
  images?: QueuedAgentMessage["images"];
  attachments?: QueuedAgentMessage["attachments"];
  sessionMode?: string;
}

export function summarizeQueuedAgentMessages(
  messages: readonly QueuedAgentMessage[] = [],
): QueuedAgentMessageSummary[] {
  return messages.map((message) => ({
    id: message.id,
    text: message.text.slice(0, 2000),
    attachmentCount: message.images.length + message.attachments.length,
    createdAt: message.createdAt,
    ...(message.error ? { error: message.error.slice(0, 2000) } : {}),
  }));
}

export class QueuedMessageHeldError extends Error {
  constructor() {
    super("Queued message was held before dispatch");
    this.name = "QueuedMessageHeldError";
  }
}

interface Dependencies {
  storage: Pick<
    AgentStorage,
    | "get"
    | "enqueueAgentMessage"
    | "removeQueuedAgentMessage"
    | "claimQueuedAgentMessage"
    | "settleQueuedAgentMessage"
    | "releaseQueuedAgentMessage"
  >;
  isIdle(agentId: string): boolean;
  dispatch(
    agentId: string,
    message: QueuedAgentMessage,
    behavior: ActiveTurnBehavior,
    canDispatch: () => boolean,
  ): Promise<boolean>;
  publish(agentId: string): Promise<void>;
  onError(error: unknown, agentId: string): void;
}

/** Durable human follow-ups. Each completed turn admits at most one next message. */
export class AgentMessageQueue {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  constructor(private readonly dependencies: Dependencies) {}

  async enqueue(input: EnqueueAgentMessageInput): Promise<QueuedAgentMessage> {
    if (this.closed) throw new Error("Daemon is shutting down");
    if (!input.text.trim() && !input.images?.length && !input.attachments?.length) {
      throw new Error("Queued message is empty");
    }
    const generation = this.generation(input.agentId);
    const message = await this.dependencies.storage.enqueueAgentMessage(input.agentId, {
      id: input.messageId ?? randomUUID(),
      text: input.text,
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      createdAt: new Date().toISOString(),
    });
    await this.dependencies.publish(input.agentId);
    // The running turn may have finished before admission reached the daemon.
    this.drain(input.agentId, generation);
    return message;
  }

  async list(agentId: string, queuedMessageId?: string): Promise<QueuedAgentMessage[]> {
    const record = await this.dependencies.storage.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} not found`);
    const messages = record.queuedMessages ?? [];
    return queuedMessageId
      ? messages.filter((message) => message.id === queuedMessageId)
      : messages;
  }

  async remove(agentId: string, messageId: string): Promise<QueuedAgentMessage | null> {
    if (this.closed) throw new Error("Daemon is shutting down");
    const message = await this.dependencies.storage.removeQueuedAgentMessage(agentId, messageId);
    await this.dependencies.publish(agentId);
    return message;
  }

  sendNow(
    agentId: string,
    messageId: string,
    behavior: ActiveTurnBehavior = "steer",
  ): Promise<void> {
    const generation = this.generation(agentId);
    return this.serial(agentId, async () => {
      if (this.closed) throw new Error("Daemon is shutting down");
      await this.dispatch(agentId, messageId, behavior, generation);
    });
  }

  drain(agentId: string, generation = this.generation(agentId)): void {
    if (this.closed) return;
    void this.serial(agentId, async () => {
      const record = await this.dependencies.storage.get(agentId);
      const message = record?.queuedMessages?.[0];
      if (
        !this.canDispatch(agentId, generation) ||
        record?.archivedAt ||
        !message ||
        message.error ||
        !this.dependencies.isIdle(agentId)
      )
        return;
      await this.dispatch(agentId, message.id, "steer", generation);
    }).catch((error) => this.dependencies.onError(error, agentId));
  }

  stop(): void {
    this.closed = true;
  }

  hold(agentId: string): void {
    this.generations.set(agentId, this.generation(agentId) + 1);
  }

  private generation(agentId: string): number {
    return this.generations.get(agentId) ?? 0;
  }

  private canDispatch(agentId: string, generation: number): boolean {
    return !this.closed && this.generation(agentId) === generation;
  }

  async flush(): Promise<void> {
    while (this.lanes.size) await Promise.allSettled(this.lanes.values());
  }

  private async dispatch(
    agentId: string,
    messageId: string,
    behavior: ActiveTurnBehavior,
    generation: number,
  ): Promise<void> {
    const message = await this.dependencies.storage.claimQueuedAgentMessage(agentId, messageId);
    if (!message) return;
    try {
      const canDispatch = () => this.canDispatch(agentId, generation);
      const sent =
        canDispatch() &&
        (await this.dependencies.dispatch(agentId, message, behavior, canDispatch));
      if (!sent) {
        await this.dependencies.storage.releaseQueuedAgentMessage(agentId, messageId);
        await this.dependencies.publish(agentId);
        return;
      }
    } catch (error) {
      if (error instanceof QueuedMessageHeldError) {
        await this.dependencies.storage.releaseQueuedAgentMessage(agentId, messageId);
        await this.dependencies.publish(agentId);
        return;
      }
      await this.dependencies.storage.settleQueuedAgentMessage({
        agentId,
        messageId,
        error: error instanceof Error ? error.message : "Failed to send queued message",
      });
      await this.dependencies.publish(agentId);
      throw error;
    }
    await this.dependencies.storage.settleQueuedAgentMessage({ agentId, messageId });
    await this.dependencies.publish(agentId);
  }

  private serial<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.lanes.set(agentId, next);
    void next
      .finally(() => {
        if (this.lanes.get(agentId) === next) this.lanes.delete(agentId);
      })
      .catch(() => undefined);
    return next;
  }
}
