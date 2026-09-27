import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ThoughtItem, ToolCallItem } from "@/types/stream";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

export type ToolCallRunEntry = ToolCallItem | ThoughtItem;

export interface ToolCallRun {
  id: string;
  /** Tool calls and the thoughts between them, in timeline order. */
  entries: readonly ToolCallRunEntry[];
  calls: readonly ToolCallItem[];
  latest: ToolCallItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  /** The trailing run when it ends the history, so live calls can extend it. */
  pendingEntries: readonly ToolCallRunEntry[];
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

export function isGroupableToolCall(item: StreamItem): item is ToolCallItem {
  if (item.kind !== "tool_call") {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function isToolCallEntry(entry: ToolCallRunEntry): entry is ToolCallItem {
  return entry.kind === "tool_call";
}

function createRun(entries: readonly ToolCallRunEntry[], isSealed: boolean): ToolCallRun {
  const calls = entries.filter(isToolCallEntry);
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, entries, calls, latest, isSealed };
}

function createHost(run: ToolCallRun): ToolCallItem {
  if (run.calls.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(entry: ToolCallRunEntry): boolean {
  if (!isToolCallEntry(entry)) {
    return false;
  }
  const status = describeToolCall(entry).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  entries: readonly ToolCallRunEntry[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.entries.length === 0) {
    return;
  }
  const run = createRun(input.entries, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: ToolCallRunEntry[] = [];
  // Thoughts join the run of the tool call that follows them. Thoughts that no
  // tool call follows before the next boundary stay standalone rows.
  let thoughts: ThoughtItem[] = [];

  for (const item of input.tail) {
    if (isGroupableToolCall(item)) {
      pending.push(...thoughts, item);
      thoughts = [];
      continue;
    }
    if (item.kind === "thought") {
      thoughts.push(item);
      continue;
    }
    appendRun({
      entries: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
    output.push(...thoughts, item);
    thoughts = [];
  }

  appendRun({
    entries: pending,
    isSealed: true,
    output,
    groups,
    buildGroup: input.buildGroup,
  });
  output.push(...thoughts);

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    pendingEntries: thoughts.length > 0 ? [] : pending,
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending: ToolCallRunEntry[] = [...input.history.pendingEntries];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;
  let thoughts: ThoughtItem[] = [];

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    const run = createRun(pending, isSealed);
    if (hostPlacement === "head") {
      head.push(createHost(run));
    }
    if (hostPlacement === "head" || pendingIncludesHead || !isSealed) {
      liveGroups.set(run.id, input.buildGroup(run));
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isGroupableToolCall(item)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(...thoughts, item);
      thoughts = [];
      pendingIncludesHead = true;
      continue;
    }
    if (item.kind === "thought") {
      thoughts.push(item);
      continue;
    }
    flush(true);
    head.push(...thoughts, item);
    thoughts = [];
  }
  if (thoughts.length > 0) {
    // A trailing thought is the visible latest row; the run before it seals
    // until a following tool call pulls the thought into the run.
    flush(true);
    head.push(...thoughts);
  } else {
    // Tool calls live in retained tail rather than the streaming head. The agent
    // lifecycle snapshot can still be idle while a newly received tool call is
    // already running, so its direct timeline status is the authoritative start
    // signal. The lifecycle state continues to keep completed calls live between
    // sequential tool updates.
    const trailingRunIsActive = input.isTurnActive || pending.some(isRunning);
    flush(!trailingRunIsActive);
  }

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  if (input.history.groupsByHostId.size === 0) {
    return {
      tail: input.history.tail,
      head,
      groupsByHostId: liveGroups,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id)) {
      historyGroupUpdatesByHostId ??= new Map();
      historyGroupUpdatesByHostId.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdatesByHostId ?? EMPTY_GROUPS,
  };
}
