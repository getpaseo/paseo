import { isTurnTrigger, isTurnBoundary } from "@/agent-stream/turn-membership";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem, ThoughtItem } from "@/types/stream";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

export type GroupableItem = ToolCallItem | ThoughtItem;

export interface ToolCallRun {
  id: string;
  calls: readonly GroupableItem[];
  latest: GroupableItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingCalls: readonly GroupableItem[];
  /** Runs this pass prepared, reused by the next pass while their calls are unchanged. */
  runs: ReadonlyMap<GroupableItem, PreparedRun<TGroup>>;
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

export function isGroupableToolCall(
  item: StreamItem,
  autoExpandReasoning = false,
): item is GroupableItem {
  if (item.kind === "thought") return !autoExpandReasoning;
  if (item.kind !== "tool_call" || isTurnTrigger(item)) {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function createRun(calls: readonly GroupableItem[], isSealed: boolean): ToolCallRun {
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, calls, latest, isSealed };
}

function createHost(run: ToolCallRun): GroupableItem {
  if (run.calls.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: GroupableItem): boolean {
  if (call.kind === "thought") return call.status !== "ready";
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

interface PreparedRun<TGroup> {
  calls: readonly GroupableItem[];
  host: GroupableItem;
  group: TGroup | undefined;
}

function hasSameCalls(a: readonly GroupableItem[], b: readonly GroupableItem[]): boolean {
  return a.length === b.length && a.every((call, index) => call === b[index]);
}

// Each tail change regroups the whole history. Reusing the previous pass's unchanged runs keeps
// host and group identities stable, so their rows do not re-render and their summaries are not
// rebuilt. Only runs used by the latest pass are kept, so paging back does not pile up stale runs.
function appendRun<TGroup>(input: {
  calls: readonly GroupableItem[];
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
  previousRuns: ReadonlyMap<GroupableItem, PreparedRun<TGroup>> | undefined;
  runs: Map<GroupableItem, PreparedRun<TGroup>>;
}): void {
  const first = input.calls[0];
  if (!first) {
    return;
  }
  let prepared = input.previousRuns?.get(first);
  if (!prepared || !hasSameCalls(prepared.calls, input.calls)) {
    const run = createRun(input.calls, true);
    prepared = {
      calls: run.calls,
      host: createHost(run),
      group: run.calls.length > 1 ? input.buildGroup(run) : undefined,
    };
  }
  input.runs.set(first, prepared);
  input.output.push(prepared.host);
  if (prepared.group !== undefined) input.groups.set(prepared.host.id, prepared.group);
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
  autoExpandReasoning?: boolean;
  previous?: GroupedHistory<TGroup> | null;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  const runs = new Map<GroupableItem, PreparedRun<TGroup>>();
  const previousRuns = input.previous?.runs;
  let pending: GroupableItem[] = [];

  for (const item of input.tail) {
    if (
      isGroupableToolCall(item, input.autoExpandReasoning) &&
      !isTurnBoundary(pending.at(-1) ?? null, item)
    ) {
      pending.push(item);
      continue;
    }
    appendRun({
      calls: pending,
      output,
      groups,
      buildGroup: input.buildGroup,
      previousRuns,
      runs,
    });
    pending = [];
    if (isGroupableToolCall(item, input.autoExpandReasoning)) pending.push(item);
    else output.push(item);
  }

  appendRun({
    calls: pending,
    output,
    groups,
    buildGroup: input.buildGroup,
    previousRuns,
    runs,
  });

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    pendingCalls: pending,
    runs,
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
  autoExpandReasoning?: boolean;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending = [...input.history.pendingCalls];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    const run = createRun(pending, isSealed);
    if (hostPlacement === "head") {
      head.push(createHost(run));
    }
    const needsLiveGroup = hostPlacement === "head" || pendingIncludesHead || !isSealed;
    if (run.calls.length > 1 && needsLiveGroup) {
      liveGroups.set(run.id, input.buildGroup(run));
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isTurnBoundary(pending.at(-1) ?? null, item)) flush(true);
    if (isGroupableToolCall(item, input.autoExpandReasoning)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(item);
      pendingIncludesHead = true;
      continue;
    }
    flush(true);
    head.push(item);
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive = input.isTurnActive || pending.some(isRunning);
  flush(!trailingRunIsActive);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    const isHistoryHost =
      input.history.groupsByHostId.has(id) || input.history.pendingCalls[0]?.id === id;
    if (isHistoryHost) {
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
