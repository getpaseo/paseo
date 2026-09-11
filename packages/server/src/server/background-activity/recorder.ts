import { randomUUID } from "node:crypto";
import type {
  BackgroundRequest,
  BackgroundAttempt,
  BackgroundConversation,
  BackgroundRow,
  AgentStreamEventPayload,
} from "@getpaseo/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import { serializeAgentStreamEvent } from "../messages.js";

interface ConversationRecord {
  metadata: BackgroundConversation;
  rows: BackgroundRow[];
  bytes: number;
  active: number;
  touched: number;
}
interface RequestInput {
  kind: BackgroundRequest["kind"];
  title: string;
  cwd: string;
  workspaceId?: string;
  sourceAgentId?: string;
  sourceTitle?: string;
  count?: number;
}

/** Observations have their own lifetime: closing a helper must not erase debugging evidence. */
export class BackgroundActivityRecorder {
  readonly epoch = randomUUID();
  private revision = 0;
  private seq = 0;
  private bytes = 0;
  private readonly requests = new Map<string, BackgroundRequest>();
  private readonly requestBytes = new Map<string, number>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly listeners = new Set<(conversationId?: string) => void>();

  constructor(private readonly budget = 128 * 1024 * 1024) {}

  create(input: RequestInput): string {
    const id = randomUUID();
    this.requests.set(id, {
      ...input,
      id,
      workspaceId: input.workspaceId ?? null,
      sourceAgentId: input.sourceAgentId ?? null,
      sourceTitle: input.sourceTitle ?? null,
      createdAt: Date.now(),
      finishedAt: null,
      status: "queued",
      error: null,
      count: input.count ?? 1,
      attempts: [],
    });
    this.measureRequest(id);
    this.trim();
    this.changed();
    return id;
  }

  queue(id: string, count: number): void {
    const request = this.requests.get(id);
    if (!request) return;
    request.count = count;
    request.status = "queued";
    request.finishedAt = null;
    request.error = null;
    this.measureRequest(id);
    this.changed();
  }

  removeQueued(id: string): void {
    if (this.requests.get(id)?.status === "queued") this.deleteRequest(id);
    this.changed();
  }

  finish(id: string, error?: unknown, canceled = false): void {
    const request = this.requests.get(id);
    if (!request) return;
    request.status = error ? "failed" : "completed";
    if (canceled) request.status = "canceled";
    request.error = error ? String(error instanceof Error ? error.message : error) : null;
    request.finishedAt = Date.now();
    this.measureRequest(id);
    this.trim();
    this.changed();
  }

  markAttemptFailure(requestId: string, error: unknown): void {
    const attempt = this.requests.get(requestId)?.attempts.at(-1);
    if (attempt) {
      attempt.error = String(error instanceof Error ? error.message : error);
      this.measureRequest(requestId);
      this.changed(attempt.conversationId);
    }
  }

  unavailable(requestId: string, provider: string, model: string | undefined, error: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    const id = randomUUID();
    const now = Date.now();
    const metadata = {
      id,
      retentionId: randomUUID(),
      cwd: request.cwd,
      provider,
      systemPrompt: null,
      truncated: false,
    };
    const size = Buffer.byteLength(JSON.stringify(metadata));
    this.bytes += size;
    this.conversations.set(id, {
      metadata,
      rows: [],
      bytes: size,
      active: 0,
      touched: now,
    });
    request.attempts.push({
      id: randomUUID(),
      conversationId: id,
      provider,
      configuredModel: model ?? null,
      resolvedModel: null,
      startedAt: now,
      finishedAt: now,
      error,
    });
    this.measureRequest(requestId);
    this.trim();
    this.changed(id);
  }

  capture(
    manager: AgentManager,
    requestId: string,
    agentId: string,
    prompt: string,
  ): (error?: unknown) => void {
    const request = this.requests.get(requestId);
    const agent = manager.getAgent(agentId);
    if (!request || !agent) return () => {};
    let conversation = this.conversations.get(agentId);
    if (!conversation) {
      conversation = {
        metadata: {
          id: agentId,
          retentionId: randomUUID(),
          cwd: agent.cwd,
          provider: agent.provider,
          systemPrompt: manager.getBackgroundSystemInstructions(agentId),
          truncated: false,
        },
        rows: [],
        bytes: 0,
        active: 0,
        touched: Date.now(),
      };
      if (Buffer.byteLength(conversation.metadata.systemPrompt ?? "") > this.budget / 4) {
        conversation.metadata.systemPrompt = null;
        conversation.metadata.truncated = true;
      }
      const size = Buffer.byteLength(JSON.stringify(conversation.metadata));
      conversation.bytes = size;
      this.bytes += size;
      this.conversations.set(agentId, conversation);
    }
    conversation.active++;
    request.status = "running";
    const attempt: BackgroundAttempt = {
      id: randomUUID(),
      conversationId: agentId,
      provider: agent.provider,
      configuredModel: agent.config.model ?? null,
      resolvedModel: agent.runtimeInfo?.model ?? null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    request.attempts.push(attempt);
    this.measureRequest(requestId);
    const append = (event: AgentStreamEventPayload) =>
      this.append(agentId, requestId, attempt.id, event);
    append({
      type: "timeline",
      provider: agent.provider,
      item: { type: "user_message", text: prompt, messageId: attempt.id },
    });
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          attempt.resolvedModel = event.agent.runtimeInfo?.model ?? attempt.resolvedModel;
          this.measureRequest(requestId);
          this.changed(agentId);
          return;
        }
        if (event.type !== "agent_stream") return;
        const payload = serializeAgentStreamEvent(event.event);
        if (!payload || (payload.type === "timeline" && payload.item.type === "user_message"))
          return;
        append(payload);
      },
      { agentId, replayState: false },
    );
    this.changed(agentId);
    let finished = false;
    return (error) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      conversation.active--;
      conversation.touched = Date.now();
      attempt.finishedAt = Date.now();
      attempt.error = error ? String(error instanceof Error ? error.message : error) : null;
      this.measureRequest(requestId);
      this.trim();
      this.changed(agentId);
    };
  }

  private append(
    conversationId: string,
    requestId: string,
    attemptId: string,
    event: AgentStreamEventPayload,
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const row: BackgroundRow = {
      seq: ++this.seq,
      requestId,
      attemptId,
      timestamp: Date.now(),
      event,
    };
    const size = Buffer.byteLength(JSON.stringify(row));
    this.trim(size);
    if (size + this.bytes > this.budget) {
      conversation.metadata.truncated = true;
    } else {
      conversation.rows.push(row);
      conversation.bytes += size;
      this.bytes += size;
    }
    this.changed(conversationId);
  }

  private trim(incoming = 0): void {
    for (const [id, conversation] of [...this.conversations].sort(
      (a, b) => a[1].touched - b[1].touched,
    )) {
      if (this.bytes + incoming <= this.budget) break;
      if (conversation.active) continue;
      this.bytes -= conversation.bytes;
      this.conversations.delete(id);
    }
    // Metadata must also stay bounded on hosts that generate many tiny requests.
    for (const [id, request] of this.requests) {
      if (this.requests.size <= 2000 && this.bytes + incoming <= this.budget) break;
      if (
        request.status === "running" ||
        request.status === "queued" ||
        request.attempts.some((attempt) => this.conversations.has(attempt.conversationId))
      )
        continue;
      this.deleteRequest(id);
    }
  }

  private measureRequest(id: string): void {
    const request = this.requests.get(id);
    if (!request) return;
    const size = Buffer.byteLength(JSON.stringify(request));
    this.bytes += size - (this.requestBytes.get(id) ?? 0);
    this.requestBytes.set(id, size);
  }
  private deleteRequest(id: string): void {
    this.bytes -= this.requestBytes.get(id) ?? 0;
    this.requestBytes.delete(id);
    this.requests.delete(id);
  }

  snapshot(conversationId?: string, afterSeq = 0) {
    const conversation = conversationId ? this.conversations.get(conversationId) : undefined;
    const remaining = conversation?.rows.filter((row) => row.seq > afterSeq) ?? [];
    const rows: BackgroundRow[] = [];
    let bytes = 0;
    for (const row of remaining) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length && (rows.length >= 100 || bytes + size > 512 * 1024)) break;
      rows.push(row);
      bytes += size;
    }
    return {
      epoch: this.epoch,
      revision: this.revision,
      requests: [...this.requests.values()].filter(
        (request) =>
          !conversationId ||
          request.attempts.some((attempt) => attempt.conversationId === conversationId),
      ),
      conversation: conversation?.metadata ?? null,
      rows,
      hasMore: remaining.length > rows.length,
    };
  }

  subscribe(listener: (conversationId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(conversationId?: string): void {
    this.revision++;
    for (const listener of this.listeners) {
      try {
        listener(conversationId);
      } catch {
        /* An observer must never fail a generation. */
      }
    }
  }
}
