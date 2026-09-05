import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";

export const AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 60;

type CoalescableTextKind = "assistant_message" | "reasoning";
type CoalescableTimelineKind = CoalescableTextKind | "tool_call";
type CoalescableTextItem = Extract<AgentTimelineItem, { type: CoalescableTextKind }>;
type CoalescableTimelineItem = Extract<AgentTimelineItem, { type: CoalescableTimelineKind }>;
type CoalescableTimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }> & {
  item: CoalescableTimelineItem;
};

export interface AgentStreamCoalescerTimers {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: typeof clearTimeout;
}

export interface AgentStreamCoalescerFlush {
  agentId: string;
  item: CoalescableTimelineItem;
  provider: AgentProvider;
  turnId?: string;
}

export interface AgentStreamCoalescerOptions {
  windowMs?: number;
  timers: AgentStreamCoalescerTimers;
  now?: () => number;
  onFlush: (payload: AgentStreamCoalescerFlush) => void | Promise<void>;
  onError?: (agentId: string, error: unknown) => void;
}

interface PendingTextEntry {
  kind: "text";
  item: CoalescableTextItem;
  text: string;
  provider: AgentProvider;
  turnId?: string;
}

interface PendingToolCallEntry {
  kind: "tool_call";
  item: Extract<AgentTimelineItem, { type: "tool_call" }>;
  provider: AgentProvider;
  turnId?: string;
}

type PendingAgentStreamEntry = PendingTextEntry | PendingToolCallEntry;

interface PendingAgentStreamBuffer {
  agentId: string;
  entries: PendingAgentStreamEntry[];
  toolCallEntryIndexes: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
  failure: unknown;
  lastFlushAt: number | null;
}

function isCoalescableTimelineEvent(event: AgentStreamEvent): event is CoalescableTimelineEvent {
  return (
    event.type === "timeline" &&
    (event.item.type === "assistant_message" ||
      event.item.type === "reasoning" ||
      event.item.type === "tool_call")
  );
}

function isTextTimelineItem(item: CoalescableTimelineItem): item is CoalescableTextItem {
  return item.type === "assistant_message" || item.type === "reasoning";
}

function isTerminalToolCall(item: CoalescableTimelineItem): boolean {
  return (
    item.type === "tool_call" &&
    (item.status === "completed" || item.status === "failed" || item.status === "canceled")
  );
}

function isSameTextStream(previous: PendingTextEntry, next: PendingTextEntry): boolean {
  if (previous.item.type !== next.item.type) {
    return false;
  }
  if (previous.item.type === "assistant_message" && next.item.type === "assistant_message") {
    return previous.item.messageId === next.item.messageId;
  }
  return true;
}

export class AgentStreamCoalescer {
  private readonly buffers = new Map<string, PendingAgentStreamBuffer>();
  private readonly onFlush: (payload: AgentStreamCoalescerFlush) => void | Promise<void>;
  private readonly timers: AgentStreamCoalescerTimers;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly onError?: AgentStreamCoalescerOptions["onError"];

  constructor(options: AgentStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
    this.timers = options.timers;
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
    this.onError = options.onError;
  }

  async handleAsync(agentId: string, event: AgentStreamEvent): Promise<boolean> {
    const activeFlush = this.buffers.get(agentId)?.flushing;
    if (activeFlush) await activeFlush;
    const handled = this.handle(agentId, event);
    const startedFlush = this.buffers.get(agentId)?.flushing;
    if (startedFlush) await startedFlush;
    return handled;
  }

  handle(agentId: string, event: AgentStreamEvent): boolean {
    if (!isCoalescableTimelineEvent(event)) {
      return false;
    }

    if (isTextTimelineItem(event.item) && event.item.text === "") {
      return true;
    }

    const buffer = this.getOrCreateBuffer(agentId);
    if (buffer.failure !== undefined) throw buffer.failure;
    this.appendToBuffer(buffer, event);

    if (isTerminalToolCall(event.item)) {
      this.flushBuffer(agentId);
      return true;
    }

    // Leading edge: the first event after an idle window flushes synchronously so
    // the first token of a turn isn't delayed a full window. Sustained bursts fall
    // through to the trailing timer, which keeps the message rate at one per
    // window. Same shape as TerminalOutputCoalescer.
    if (!buffer.timer) {
      const elapsed =
        buffer.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - buffer.lastFlushAt;
      if (elapsed >= this.windowMs) {
        this.flushBuffer(agentId);
        return true;
      }
      this.scheduleFlush(buffer);
    }

    return true;
  }

  async flushFor(agentId: string): Promise<void> {
    while (true) {
      const buffer = this.buffers.get(agentId);
      if (!buffer || (!buffer.flushing && buffer.entries.length === 0)) return;
      if (buffer.failure !== undefined) throw buffer.failure;
      await this.flushBuffer(agentId);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      Array.from(this.buffers.keys()).map(async (agentId) => await this.flushFor(agentId)),
    );
  }

  async flushAndDiscard(agentId: string): Promise<void> {
    await this.flushFor(agentId);
    this.discard(agentId);
  }

  discard(agentId: string): void {
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
      entries: [],
      toolCallEntryIndexes: new Map(),
      timer: null,
      flushing: null,
      failure: undefined,
      lastFlushAt: null,
    };
    this.buffers.set(agentId, buffer);
    return buffer;
  }

  private appendToBuffer(buffer: PendingAgentStreamBuffer, event: CoalescableTimelineEvent): void {
    if (isTextTimelineItem(event.item)) {
      buffer.entries.push({
        kind: "text",
        item: event.item,
        text: event.item.text,
        provider: event.provider,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
      return;
    }

    const existingIndex = buffer.toolCallEntryIndexes.get(event.item.callId);
    const entry: PendingToolCallEntry = {
      kind: "tool_call",
      item: event.item,
      provider: event.provider,
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    };

    if (existingIndex !== undefined) {
      buffer.entries[existingIndex] = entry;
      return;
    }

    buffer.toolCallEntryIndexes.set(event.item.callId, buffer.entries.length);
    buffer.entries.push(entry);
  }

  private scheduleFlush(buffer: PendingAgentStreamBuffer): void {
    const timer = this.timers.setTimeout(() => {
      void this.flushBuffer(buffer.agentId, buffer).catch((error: unknown) => {
        this.onError?.(buffer.agentId, error);
      });
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

  private flushBuffer(agentId: string, expectedBuffer?: PendingAgentStreamBuffer): Promise<void> {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return Promise.resolve();
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return Promise.resolve();
    }
    if (buffer.flushing) return buffer.flushing;

    this.clearTimer(buffer);
    if (buffer.entries.length === 0) {
      return Promise.resolve();
    }

    const entries = this.collapseEntries(buffer.entries);
    buffer.entries = [];
    buffer.toolCallEntryIndexes.clear();
    buffer.lastFlushAt = this.now();
    const finish = () => {
      buffer.flushing = null;
      if (buffer.failure === undefined && buffer.entries.length > 0 && !buffer.timer) {
        this.scheduleFlush(buffer);
      }
    };
    const restore = (start: number) => {
      buffer.entries = [...entries.slice(start), ...buffer.entries];
      this.rebuildToolCallIndexes(buffer);
    };
    const payload = (entry: PendingAgentStreamEntry): AgentStreamCoalescerFlush => ({
      agentId,
      item:
        entry.kind === "text"
          ? {
              ...entry.item,
              text: entry.text,
            }
          : entry.item,
      provider: entry.provider,
      ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
    });
    for (let index = 0; index < entries.length; index += 1) {
      let completion: void | Promise<void>;
      try {
        completion = this.onFlush(payload(entries[index]!));
      } catch (error) {
        restore(index);
        buffer.failure = error;
        finish();
        return Promise.reject(error);
      }
      if (!completion) continue;
      buffer.flushing = (async () => {
        let pendingIndex = index;
        try {
          await completion;
          for (pendingIndex = index + 1; pendingIndex < entries.length; pendingIndex += 1) {
            await this.onFlush(payload(entries[pendingIndex]!));
          }
        } catch (error) {
          restore(pendingIndex);
          buffer.failure = error;
          throw error;
        }
      })().finally(finish);
      return buffer.flushing;
    }
    finish();
    return Promise.resolve();
  }

  private rebuildToolCallIndexes(buffer: PendingAgentStreamBuffer): void {
    buffer.toolCallEntryIndexes.clear();
    buffer.entries.forEach((entry, index) => {
      if (entry.kind === "tool_call") buffer.toolCallEntryIndexes.set(entry.item.callId, index);
    });
  }

  private collapseEntries(entries: PendingAgentStreamEntry[]): PendingAgentStreamEntry[] {
    const collapsed: PendingAgentStreamEntry[] = [];

    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.kind === "text" &&
        entry.kind === "text" &&
        isSameTextStream(previous, entry) &&
        previous.provider === entry.provider &&
        previous.turnId === entry.turnId
      ) {
        previous.text += entry.text;
        continue;
      }

      collapsed.push({ ...entry });
    }

    return collapsed;
  }
}
