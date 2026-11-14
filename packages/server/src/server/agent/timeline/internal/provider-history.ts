import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { mergeToolCallItems, type ProjectedTimelineRow } from "../../timeline-projection.js";
import type { TimelineEntry, TimelinePrompt } from "./backend.js";

/**
 * What the provider's history adds to the owned history. Owned rows are never changed: the plan
 * only appends rows the provider has after them.
 */
export type ProviderHistoryPlan =
  | { kind: "unchanged" }
  | { kind: "append"; entries: TimelineEntry[] }
  | { kind: "diverged"; reason: string };

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

/**
 * A run of turn content compared as a whole. Consecutive assistant text joins into one text
 * segment, as the projection joins streamed chunks; a tool call folds its updates by `callId`.
 */
type Segment =
  | { kind: "text" | "reasoning"; text: string }
  | { kind: "tool_call"; item: ToolCallItem }
  | { kind: "item"; item: AgentTimelineItem };

interface Turn {
  /** The provider's id for the prompt that opens the turn. */
  promptId: string | undefined;
  /** The opening prompt's text, as the timeline shows it. */
  promptText: string;
  segments: Segment[];
}

interface OwnedTurn extends Turn {
  /** A prompt Paseo submitted that the provider never acknowledged follows the opening prompt. */
  hasUndeliveredPrompt: boolean;
}

interface ProviderTurn extends Turn {
  /** Index of the opening prompt in the provider entries. */
  start: number;
  /** Index of the first and of the last provider entry of each segment. */
  segmentStarts: number[];
  segmentEnds: number[];
}

/**
 * Turns are aligned by the provider's prompt ids and compared exactly, prompt text included. A
 * provider prompt id repeated with other text is divergence. Every owned turn but the
 * last must equal the provider's. The last may be a whole-segment prefix of the provider's, whose
 * further rows are appended as new rows. A segment that differs at all, including an answer Paseo
 * saw only part of or a tool call that finished since, is divergence, and nothing is written.
 *
 * Compared: assistant and reasoning text exactly, tool calls by `callId`, `name`, `status`,
 * `error` and `detail`, and every other item except the ones Paseo writes itself (errors,
 * notifications, plugin rows). Tool call `metadata` is not compared.
 */
export function planProviderHistory(input: {
  rows: readonly ProjectedTimelineRow[];
  prompts: readonly TimelinePrompt[];
  provider: readonly TimelineEntry[];
}): ProviderHistoryPlan {
  const owned = ownedTurns(input.rows, input.prompts);
  const provider = providerTurns(input.provider);
  if ([...owned.turns, ...provider].some((turn) => turn.promptId === undefined)) {
    return { kind: "diverged", reason: "A prompt has no provider id" };
  }
  if (owned.turns.length > provider.length) {
    return { kind: "diverged", reason: "The provider history is missing turns Paseo shows" };
  }
  if (provider.some((turn, index) => index > 0 && turn.promptId === provider[index - 1].promptId)) {
    return { kind: "diverged", reason: "The provider history has two prompts with one id" };
  }
  const promptsDiffer = owned.turns.some(
    (turn, index) =>
      turn.promptId !== provider[index].promptId || turn.promptText !== provider[index].promptText,
  );
  if (promptsDiffer) {
    return { kind: "diverged", reason: "The provider history has different prompts" };
  }
  const last = owned.turns.length - 1;
  const earlierDiffers = owned.turns
    .slice(0, Math.max(last, 0))
    .some((turn, index) => !sameSegments(turn.segments, provider[index].segments));
  if (earlierDiffers) {
    return { kind: "diverged", reason: "The provider history has a different answer" };
  }

  let appendFrom: number;
  if (last < 0) {
    appendFrom = input.rows.length === 0 ? 0 : (provider[0]?.start ?? input.provider.length);
  } else {
    const from = continuationStart(owned.turns[last], provider[last]);
    if (from === null) {
      return { kind: "diverged", reason: "The provider history has a different last answer" };
    }
    appendFrom = from ?? provider[last + 1]?.start ?? input.provider.length;
  }

  const entries = input.provider.slice(appendFrom);
  if (entries.length === 0) return { kind: "unchanged" };
  const trailing = last >= 0 ? owned.turns[last] : owned.preamble;
  if (trailing.hasUndeliveredPrompt) {
    // Appending would put provider turns after a prompt the provider never received.
    return { kind: "diverged", reason: "A prompt the provider did not receive is last" };
  }
  return { kind: "append", entries };
}

/**
 * Where the provider's last-turn entries continue past the owned turn: an entry index, undefined
 * when the turns are equal, or null when the owned turn is not a whole-segment prefix of the
 * provider's. Appended entries must not update a segment Paseo already shows, such as a later
 * update to a tool call.
 */
function continuationStart(owned: OwnedTurn, provider: ProviderTurn): number | undefined | null {
  const matched = owned.segments.length;
  if (!sameSegments(owned.segments, provider.segments.slice(0, matched))) return null;
  if (matched === provider.segments.length) return undefined;
  const from = provider.segmentStarts[matched];
  const matchedEnd = Math.max(provider.start, ...provider.segmentEnds.slice(0, matched));
  return matchedEnd < from ? from : null;
}

function ownedTurns(
  rows: readonly ProjectedTimelineRow[],
  prompts: readonly TimelinePrompt[],
): { preamble: OwnedTurn; turns: OwnedTurn[] } {
  const promptsBySeq = new Map(prompts.map((prompt) => [prompt.seqStart, prompt]));
  const preamble: OwnedTurn = {
    promptId: undefined,
    promptText: "",
    segments: [],
    hasUndeliveredPrompt: false,
  };
  const turns: OwnedTurn[] = [];
  let current = preamble;
  for (const row of rows) {
    const prompt = row.item.type === "user_message" ? promptsBySeq.get(row.seqStart) : undefined;
    if (
      prompt &&
      row.item.type === "user_message" &&
      (!prompt.submitted || prompt.providerMessageId)
    ) {
      current = {
        promptId: prompt.providerMessageId ?? prompt.messageId,
        promptText: row.item.text,
        segments: [],
        hasUndeliveredPrompt: false,
      };
      turns.push(current);
    } else if (prompt) {
      current.hasUndeliveredPrompt = true;
    } else {
      addToSegments(current.segments, row.item);
    }
  }
  return { preamble, turns };
}

function providerTurns(entries: readonly TimelineEntry[]): ProviderTurn[] {
  const turns: ProviderTurn[] = [];
  entries.forEach((entry, index) => {
    const current = turns.at(-1);
    if (entry.item.type === "user_message") {
      // Some providers replay a prompt twice in a row; it is one turn. The same id with other
      // text opens its own turn, which the plan reports as divergence.
      const repeated =
        entry.item.messageId !== undefined &&
        current?.promptId === entry.item.messageId &&
        current.promptText === entry.item.text;
      if (!repeated) {
        turns.push({
          promptId: entry.item.messageId,
          promptText: entry.item.text,
          segments: [],
          start: index,
          segmentStarts: [],
          segmentEnds: [],
        });
      }
      return;
    }
    if (!current) return;
    const segment = addToSegments(current.segments, entry.item);
    if (segment === null) return;
    if (segment === current.segmentStarts.length) current.segmentStarts.push(index);
    current.segmentEnds[segment] = index;
  });
  return turns;
}

/** Adds an item to its turn's segments; returns the segment's index, or null if not compared. */
function addToSegments(segments: Segment[], item: AgentTimelineItem): number | null {
  const previous = segments.at(-1);
  switch (item.type) {
    case "assistant_message":
    case "reasoning": {
      const kind = item.type === "assistant_message" ? "text" : "reasoning";
      if (previous?.kind === kind) {
        previous.text += item.text;
      } else {
        segments.push({ kind, text: item.text });
      }
      return segments.length - 1;
    }
    case "tool_call": {
      const index = segments.findIndex(
        (segment) => segment.kind === "tool_call" && segment.item.callId === item.callId,
      );
      const existing = segments[index];
      if (existing?.kind !== "tool_call") {
        segments.push({ kind: "tool_call", item });
        return segments.length - 1;
      }
      existing.item = mergeToolCallItems(existing.item, item);
      return index;
    }
    case "user_message":
    case "error":
    case "notification":
    case "plugin":
      return null;
    default:
      segments.push({ kind: "item", item });
      return segments.length - 1;
  }
}

function sameSegments(a: readonly Segment[], b: readonly Segment[]): boolean {
  return a.length === b.length && a.every((segment, index) => sameSegment(segment, b[index]));
}

function sameSegment(a: Segment, b: Segment): boolean {
  if (a.kind === "tool_call" || b.kind === "tool_call") {
    return (
      a.kind === "tool_call" &&
      b.kind === "tool_call" &&
      sameValue(toolCallContent(a.item), toolCallContent(b.item))
    );
  }
  if (a.kind === "item" || b.kind === "item") {
    return a.kind === "item" && b.kind === "item" && sameValue(a.item, b.item);
  }
  return a.kind === b.kind && a.text === b.text;
}

function toolCallContent(item: ToolCallItem): unknown {
  return {
    callId: item.callId,
    name: item.name,
    status: item.status,
    error: item.error,
    detail: item.detail,
  };
}

/** Structural equality: object key order and absent-versus-undefined keys are not content. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = definedKeys(a);
  const bKeys = definedKeys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => sameValue(a[key], b[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}
