import { getStreamItemMessageId, type StreamItem, type ToolCallItem } from "@/types/stream";
import { summarizeToolCalls, type OverviewSummary } from "@/tool-calls/detail-level/overview/model";

export interface TurnSummary {
  messageCount: number;
  tools: OverviewSummary;
}

export interface CollapsedTurn {
  /** The user message the turn answers. Its row carries the turn's summary line. */
  hostId: string;
  expanded: boolean;
  summary: TurnSummary;
}

export interface TurnCollapse {
  tail: StreamItem[];
  turnsByHostId: ReadonlyMap<string, CollapsedTurn>;
  /** Rows of expanded turns, which render inside the turn's indent rail. */
  nestedItemIds: ReadonlySet<string>;
  /** The turn a folded message belongs to, for surfaces that must reveal it. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
}

export interface CollapseTurnsInput {
  tail: StreamItem[];
  /** The latest turn is still producing output, so it stays unfolded. */
  isLatestTurnOpen: boolean;
  expandedHostIds: ReadonlySet<string>;
  /** The calls a tool-call group row stands for; undefined for a single call. */
  getGroupedCalls: (itemId: string) => readonly ToolCallItem[] | undefined;
}

const EMPTY_TURNS: ReadonlyMap<string, CollapsedTurn> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();

function summarizeTurn(
  items: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): TurnSummary {
  const calls: ToolCallItem[] = [];
  let messageCount = 0;
  for (const item of items) {
    if (item.kind === "assistant_message") messageCount += 1;
    else if (item.kind === "tool_call") calls.push(...(getGroupedCalls(item.id) ?? [item]));
  }
  return { messageCount, tools: summarizeToolCalls(calls) };
}

function hasWork(summary: TurnSummary): boolean {
  return summary.messageCount > 0 || Object.values(summary.tools).some((count) => count > 0);
}

function findLastAssistantIndex(tail: StreamItem[], start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (tail[index]?.kind === "assistant_message") return index;
  }
  return -1;
}

/**
 * Folds each answered turn into its user message: everything the agent did before its last
 * message collapses into one summary line, and that message stays in the chat. A turn folds
 * only once it is complete, its user message is loaded, and it sent messages or called tools
 * before its reply. Thoughts fold with the turn but are not counted.
 */
export function collapseTurns(input: CollapseTurnsInput): TurnCollapse {
  const { tail } = input;
  const output: StreamItem[] = [];
  const turnsByHostId = new Map<string, CollapsedTurn>();
  const nestedItemIds = new Set<string>();
  const hostIdByFoldedMessageId = new Map<string, string>();

  let runStart = 0;
  const flushRun = (runEnd: number) => {
    const host = tail[runStart - 1];
    const isClosed = runEnd < tail.length || !input.isLatestTurnOpen;
    const replyIndex = findLastAssistantIndex(tail, runStart, runEnd);
    if (host?.kind !== "user_message" || !isClosed || replyIndex <= runStart) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const folded = tail.slice(runStart, replyIndex);
    const summary = summarizeTurn(folded, input.getGroupedCalls);
    if (!hasWork(summary)) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const expanded = input.expandedHostIds.has(host.id);
    turnsByHostId.set(host.id, { hostId: host.id, expanded, summary });
    for (const item of folded) {
      hostIdByFoldedMessageId.set(getStreamItemMessageId(item), host.id);
      if (expanded) nestedItemIds.add(item.id);
    }
    if (expanded) output.push(...folded);
    output.push(...tail.slice(replyIndex, runEnd));
  };

  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index]?.kind !== "user_message") continue;
    flushRun(index);
    output.push(tail[index]!);
    runStart = index + 1;
  }
  flushRun(tail.length);

  if (turnsByHostId.size === 0) {
    return {
      tail,
      turnsByHostId: EMPTY_TURNS,
      nestedItemIds: EMPTY_IDS,
      hostIdByFoldedMessageId: EMPTY_HOSTS,
    };
  }
  return {
    tail: output.length === tail.length ? tail : output,
    turnsByHostId,
    nestedItemIds,
    hostIdByFoldedMessageId,
  };
}
