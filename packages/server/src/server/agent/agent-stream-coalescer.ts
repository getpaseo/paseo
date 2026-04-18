import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";

export const AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 33;

type ChunkableTimelineKind = "assistant_message" | "reasoning";
type ChunkableTimelineItem = Extract<AgentTimelineItem, { type: ChunkableTimelineKind }>;
type ChunkableTimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }> & {
  item: ChunkableTimelineItem;
};

export type AgentStreamCoalescerTimers = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export type AgentStreamCoalescerFlush = {
  agentId: string;
  item: Extract<AgentTimelineItem, { type: "assistant_message" | "reasoning" }>;
  provider: AgentProvider;
  turnId?: string;
};

export type AgentStreamCoalescerOptions = {
  windowMs?: number;
  timers: AgentStreamCoalescerTimers;
  onFlush: (payload: AgentStreamCoalescerFlush) => void;
};

type PendingAgentStreamChunk = {
  item: ChunkableTimelineItem;
  text: string;
  provider: AgentProvider;
  turnId?: string;
};

type PendingAgentStreamBuffer = {
  agentId: string;
  chunks: PendingAgentStreamChunk[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
};

function isChunkableTimelineEvent(event: AgentStreamEvent): event is ChunkableTimelineEvent {
  return (
    event.type === "timeline" &&
    (event.item.type === "assistant_message" || event.item.type === "reasoning") &&
    typeof event.item.text === "string"
  );
}

export class AgentStreamCoalescer {
  private readonly buffers = new Map<string, PendingAgentStreamBuffer>();
  private readonly onFlush: (payload: AgentStreamCoalescerFlush) => void;
  private readonly timers: AgentStreamCoalescerTimers;
  private readonly windowMs: number;

  constructor(options: AgentStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
    this.timers = options.timers;
    this.onFlush = options.onFlush;
  }

  handle(agentId: string, event: AgentStreamEvent): boolean {
    if (!isChunkableTimelineEvent(event)) {
      return false;
    }

    if (event.item.text === "") {
      return true;
    }

    const buffer = this.getOrCreateBuffer(agentId);
    buffer.chunks.push({
      item: event.item,
      text: event.item.text,
      provider: event.provider,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    });

    if (!buffer.timer) {
      this.scheduleFlush(buffer);
    }

    return true;
  }

  flushFor(agentId: string): void {
    this.flushBuffer(agentId);
  }

  flushAll(): void {
    for (const agentId of Array.from(this.buffers.keys())) {
      this.flushBuffer(agentId);
    }
  }

  flushAndDiscard(agentId: string): void {
    this.flushBuffer(agentId);
    const buffer = this.buffers.get(agentId);
    if (buffer) {
      this.clearTimer(buffer);
      this.buffers.delete(agentId);
    }
  }

  private getOrCreateBuffer(agentId: string): PendingAgentStreamBuffer {
    const existing = this.buffers.get(agentId);
    if (existing) {
      return existing;
    }

    const buffer: PendingAgentStreamBuffer = {
      agentId,
      chunks: [],
      timer: null,
      flushing: false,
    };
    this.buffers.set(agentId, buffer);
    return buffer;
  }

  private scheduleFlush(buffer: PendingAgentStreamBuffer): void {
    const timer = this.timers.setTimeout(() => {
      this.flushBuffer(buffer.agentId, buffer);
    }, this.windowMs);
    timer.unref?.();
    buffer.timer = timer;
  }

  private clearTimer(buffer: PendingAgentStreamBuffer): void {
    if (!buffer.timer) {
      return;
    }
    this.timers.clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  private flushBuffer(agentId: string, expectedBuffer?: PendingAgentStreamBuffer): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return;
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return;
    }
    if (buffer.flushing) {
      return;
    }

    this.clearTimer(buffer);
    if (buffer.chunks.length === 0) {
      return;
    }

    const chunks = buffer.chunks;
    buffer.chunks = [];
    buffer.flushing = true;

    try {
      for (const chunk of this.collapseChunks(chunks)) {
        this.onFlush({
          agentId,
          item: {
            ...chunk.item,
            text: chunk.text,
          },
          provider: chunk.provider,
          ...(chunk.turnId !== undefined ? { turnId: chunk.turnId } : {}),
        });
      }
    } finally {
      buffer.flushing = false;
    }
  }

  private collapseChunks(chunks: PendingAgentStreamChunk[]): PendingAgentStreamChunk[] {
    const collapsed: PendingAgentStreamChunk[] = [];

    for (const chunk of chunks) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.item.type === chunk.item.type &&
        previous.provider === chunk.provider &&
        previous.turnId === chunk.turnId
      ) {
        previous.text += chunk.text;
        continue;
      }

      collapsed.push({ ...chunk });
    }

    return collapsed;
  }
}
