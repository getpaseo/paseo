import type { ToolCallDetail } from "../../agent-sdk-types.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

export interface OmpSubagentCardTimer {
  readonly token: unknown;
}

export interface OmpSubagentCardScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): OmpSubagentCardTimer;
  clearTimeout(timer: OmpSubagentCardTimer): void;
}

export interface OmpSubagentCardTrackerOptions {
  scheduler?: OmpSubagentCardScheduler;
  emitToolCall?: (toolCallId: string) => boolean;
}

interface OmpSubagentLogLine {
  key: string;
  text: string;
}

interface OmpSubagentCardItem {
  index: number;
  description?: string;
  agent?: string;
  status?: "pending" | "running" | "completed" | "failed" | "aborted";
  childSessionId?: string;
  lines: OmpSubagentLogLine[];
  lineKeys: Set<string>;
}

interface OmpSubagentCardState {
  items: Map<number, OmpSubagentCardItem>;
  emitToolCall: (toolCallId: string) => boolean;
  lastEmitMs: number | null;
  trailingTimer: OmpSubagentCardTimer | null;
  dirty: boolean;
}

const MAX_LOG_LINES_PER_ITEM = 200;
const MAX_LOG_LINE_CHARS = 240;
const THROTTLE_INTERVAL_MS = 500;

export function createOmpSubagentCardScheduler(): OmpSubagentCardScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => ({ token: setTimeout(callback, delayMs) }),
    clearTimeout: (timer) => {
      clearTimeout(timer.token as ReturnType<typeof setTimeout>);
    },
  };
}

export class OmpSubagentCardTracker {
  private readonly scheduler: OmpSubagentCardScheduler;
  private readonly emitToolCall: (toolCallId: string) => boolean;
  private readonly states = new Map<string, OmpSubagentCardState>();

  constructor(options: OmpSubagentCardTrackerOptions) {
    this.scheduler = options.scheduler ?? createOmpSubagentCardScheduler();
    this.emitToolCall = options.emitToolCall ?? (() => false);
  }

  handleLifecycle(
    payload: OmpSubagentLifecyclePayload,
    emitToolCall: (toolCallId: string) => boolean = this.emitToolCall,
  ): void {
    const parentToolCallId = readTrimmedString(payload.parentToolCallId);
    if (!parentToolCallId) {
      return;
    }
    this.stateFor(parentToolCallId).emitToolCall = emitToolCall;
    const item = this.upsertItem(parentToolCallId, {
      index: payload.index,
      agent: payload.agent,
      description: payload.description,
      status: payload.status === "started" ? "running" : payload.status,
      childSessionId: payload.sessionFile,
    });
    this.appendLine(
      item,
      `lifecycle:${payload.status}:${payload.id}`,
      `${payload.id} ${payload.status}`,
    );
    this.requestEmit(parentToolCallId);
  }

  handleProgress(
    payload: OmpSubagentProgressPayload,
    emitToolCall: (toolCallId: string) => boolean = this.emitToolCall,
  ): void {
    const parentToolCallId = readTrimmedString(payload.parentToolCallId);
    if (!parentToolCallId) {
      return;
    }
    this.stateFor(parentToolCallId).emitToolCall = emitToolCall;
    const item = this.upsertItem(parentToolCallId, {
      index: payload.index,
      agent: payload.agent,
      description: payload.progress.description,
      status: payload.progress.status,
      childSessionId: payload.sessionFile,
    });

    const currentToolLine = summarizeTool(readRecord(payload.progress.currentTool));
    if (currentToolLine) {
      this.appendLine(item, `current:${currentToolLine.key}`, currentToolLine.text);
    }

    for (const tool of readRecordArray(payload.progress.recentTools)) {
      const line = summarizeTool(tool);
      if (line) {
        this.appendLine(item, `tool:${line.key}`, line.text);
      }
    }

    for (const output of readOutputLines(payload.progress.recentOutput)) {
      this.appendLine(item, `output:${output}`, output);
    }

    if (payload.progress.status !== "running") {
      this.appendLine(
        item,
        `status:${payload.progress.status}:${payload.progress.id}`,
        `${payload.progress.id} ${payload.progress.status}`,
      );
    }

    this.requestEmit(parentToolCallId);
  }

  detailFor(toolCallId: string, baseDetail: ToolCallDetail): ToolCallDetail {
    if (baseDetail.type !== "sub_agent") {
      return baseDetail;
    }
    const state = this.states.get(toolCallId);
    if (!state) {
      return baseDetail;
    }
    const items = [...state.items.values()].sort((left, right) => left.index - right.index);
    const firstItem = items[0];
    if (!firstItem) {
      return baseDetail;
    }

    const detail: ToolCallDetail = {
      type: "sub_agent",
      ...(baseDetail.subAgentType ? { subAgentType: baseDetail.subAgentType } : {}),
      ...((baseDetail.description ?? firstItem.description)
        ? { description: baseDetail.description ?? firstItem.description }
        : {}),
      ...((firstItem.childSessionId ?? baseDetail.childSessionId)
        ? { childSessionId: firstItem.childSessionId ?? baseDetail.childSessionId }
        : {}),
      log: buildLog(items, baseDetail.log),
    };
    return baseDetail.actions ? { ...detail, actions: baseDetail.actions } : detail;
  }

  flush(toolCallId: string): void {
    const state = this.states.get(toolCallId);
    if (!state || !state.dirty) {
      return;
    }
    this.emitNow(toolCallId, state);
  }

  delete(toolCallId: string): void {
    const state = this.states.get(toolCallId);
    if (state?.trailingTimer) {
      this.scheduler.clearTimeout(state.trailingTimer);
    }
    this.states.delete(toolCallId);
  }

  clear(): void {
    for (const toolCallId of this.states.keys()) {
      this.delete(toolCallId);
    }
  }

  private upsertItem(
    parentToolCallId: string,
    input: {
      index: number;
      agent?: string;
      status?: "pending" | "running" | "completed" | "failed" | "aborted";
      description?: string;
      childSessionId?: string;
    },
  ): OmpSubagentCardItem {
    const state = this.stateFor(parentToolCallId);
    const existing = state.items.get(input.index);
    if (existing) {
      existing.agent = readTrimmedString(input.agent) ?? existing.agent;
      existing.status = input.status ?? existing.status;
      existing.description = readTrimmedString(input.description) ?? existing.description;
      existing.childSessionId = readTrimmedString(input.childSessionId) ?? existing.childSessionId;
      return existing;
    }

    const item: OmpSubagentCardItem = {
      index: input.index,
      lines: [],
      lineKeys: new Set<string>(),
      ...(readTrimmedString(input.agent) ? { agent: readTrimmedString(input.agent) } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(readTrimmedString(input.description)
        ? { description: readTrimmedString(input.description) }
        : {}),
      ...(readTrimmedString(input.childSessionId)
        ? { childSessionId: readTrimmedString(input.childSessionId) }
        : {}),
    };
    state.items.set(input.index, item);
    return item;
  }

  private stateFor(parentToolCallId: string): OmpSubagentCardState {
    const existing = this.states.get(parentToolCallId);
    if (existing) {
      return existing;
    }
    const state: OmpSubagentCardState = {
      items: new Map(),
      emitToolCall: this.emitToolCall,
      lastEmitMs: null,
      trailingTimer: null,
      dirty: false,
    };
    this.states.set(parentToolCallId, state);
    return state;
  }

  private appendLine(item: OmpSubagentCardItem, key: string, text: string): void {
    const normalizedText = normalizeLine(text);
    if (!normalizedText || item.lineKeys.has(key)) {
      return;
    }
    item.lines.push({ key, text: normalizedText });
    item.lineKeys.add(key);
    while (item.lines.length > MAX_LOG_LINES_PER_ITEM) {
      const removed = item.lines.shift();
      if (removed) {
        item.lineKeys.delete(removed.key);
      }
    }
  }

  private requestEmit(toolCallId: string): void {
    const state = this.stateFor(toolCallId);
    const now = this.scheduler.now();
    const elapsedMs = state.lastEmitMs === null ? THROTTLE_INTERVAL_MS : now - state.lastEmitMs;
    if (elapsedMs >= THROTTLE_INTERVAL_MS) {
      this.emitNow(toolCallId, state);
      return;
    }

    state.dirty = true;
    if (state.trailingTimer) {
      return;
    }
    state.trailingTimer = this.scheduler.setTimeout(() => {
      state.trailingTimer = null;
      if (state.dirty) {
        this.emitNow(toolCallId, state);
      }
    }, THROTTLE_INTERVAL_MS - elapsedMs);
  }

  private emitNow(toolCallId: string, state: OmpSubagentCardState): void {
    if (state.trailingTimer) {
      this.scheduler.clearTimeout(state.trailingTimer);
      state.trailingTimer = null;
    }
    state.dirty = false;
    state.lastEmitMs = this.scheduler.now();
    state.emitToolCall(toolCallId);
  }
}

function buildLog(items: OmpSubagentCardItem[], fallback: string): string {
  const itemCount = Math.max(...items.map((item) => item.index)) + 1;
  const lines = items.flatMap((item) => {
    const prefix = itemCount > 1 ? `[${item.index + 1}/${itemCount}] ` : "";
    return item.lines.map((line) => `${prefix}${line.text}`);
  });
  return lines.length > 0 ? lines.join("\n") : fallback;
}

function summarizeTool(tool: Record<string, unknown> | null): OmpSubagentLogLine | null {
  if (!tool) {
    return null;
  }
  const toolName = readTrimmedString(tool.tool) ?? readTrimmedString(tool.name);
  if (!toolName) {
    return null;
  }
  const args = readTrimmedString(tool.args) ?? summarizeUnknown(tool.input);
  const endMs = typeof tool.endMs === "number" ? `:${tool.endMs}` : "";
  return {
    key: `${toolName}:${args ?? ""}${endMs}`,
    text: args ? `[${toolName}] ${args}` : `[${toolName}]`,
  };
}

function readOutputLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const text =
      readTrimmedString(item) ??
      (isRecord(item)
        ? (readTrimmedString(item.text) ??
          readTrimmedString(item.output) ??
          readTrimmedString(item.content))
        : undefined);
    return text ? [text] : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return readTrimmedString(value);
  }
  const json = JSON.stringify(value);
  return typeof json === "string" ? normalizeLine(json) : undefined;
}

function normalizeLine(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_LOG_LINE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_LOG_LINE_CHARS)}...`;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
