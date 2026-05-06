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
  onFlush: (payload: AgentStreamCoalescerFlush) => void;
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
  flushing: boolean;
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
    if (!isCoalescableTimelineEvent(event)) {
      return false;
    }

    if (isTextTimelineItem(event.item) && event.item.text === "") {
      return true;
    }

    const buffer = this.getOrCreateBuffer(agentId);
    this.appendToBuffer(buffer, event);

    if (isTerminalToolCall(event.item)) {
      this.flushBuffer(agentId);
      return true;
    }

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
      entries: [],
      toolCallEntryIndexes: new Map(),
      timer: null,
      flushing: false,
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
    if (buffer.entries.length === 0) {
      return;
    }

    const entries = buffer.entries;
    buffer.entries = [];
    buffer.toolCallEntryIndexes.clear();
    buffer.flushing = true;

    try {
      for (const entry of this.collapseEntries(entries)) {
        this.onFlush({
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
      }
    } finally {
      buffer.flushing = false;
    }
  }

  private collapseEntries(entries: PendingAgentStreamEntry[]): PendingAgentStreamEntry[] {
    const collapsed: PendingAgentStreamEntry[] = [];

    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.kind === "text" &&
        entry.kind === "text" &&
        previous.item.type === entry.item.type &&
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
