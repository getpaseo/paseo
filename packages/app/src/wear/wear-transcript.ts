import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";

import {
  WEAR_PROTOCOL_VERSION,
  type WearTranscript,
  type WearTranscriptEntry,
} from "./wear-protocol";

/**
 * How much conversation the watch gets.
 *
 * A wrist can't scroll a thousand turns, and a DataItem has a hard ~100 KB limit,
 * so the transcript is a tail rather than the whole history. Both caps trim the
 * OLDEST entries: the newest turn is the one the user opened the screen to read.
 */
export const MAX_TRANSCRIPT_ENTRIES = 100;

/**
 * Well under the ~100 KB DataItem ceiling. The headroom is deliberate — exceeding
 * the real limit fails the put outright, so the watch would show nothing at all
 * rather than a shortened conversation.
 */
const MAX_TRANSCRIPT_BYTES = 48 * 1024;

const MAX_MESSAGE_LENGTH = 300;
const MAX_TOOL_LENGTH = 100;
const MAX_ERROR_LENGTH = 200;

const FAILED_SUFFIX = " (failed)";

export interface WearTranscriptInput {
  agentId: string;
  serverId: string;
  /** Projected timeline items, oldest to newest. */
  items: AgentTimelineItem[];
  /** The daemon reported history before the first item we were given. */
  hasOlder: boolean;
}

/**
 * Normalise prose while keeping its shape.
 *
 * Unlike the snapshot's `truncate`, this preserves single newlines: an assistant
 * message is often a short list, and flattening it to one line makes it unreadable
 * on a small round screen. Runs of blank lines collapse to one, because vertical
 * space is the scarcest thing on a watch.
 */
function normalizeProse(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // Horizontal whitespace only — \n is excluded so the line structure survives.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Everything onto one line, for the single-line tool summary. */
function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value;

  // `length` counts UTF-16 code units, so slicing can land between the halves of a
  // surrogate pair and leave an unpaired one before the ellipsis — which renders as
  // a replacement box on the watch. Drop the orphaned half rather than emit it.
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;

  return `${value.slice(0, end)}…`;
}

function firstLine(value: string): string {
  return normalizeLine(value.split("\n")[0] ?? "");
}

/**
 * UTF-8 byte length.
 *
 * Computed by hand rather than with TextEncoder, which is not guaranteed to exist
 * on Hermes. `length` alone would undercount every non-ASCII payload, and this cap
 * exists precisely to stop an oversized put.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      // Surrogate pair: four bytes for the pair, and the low half is consumed here.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The most specific string in a tool call's detail.
 *
 * A bare tool name tells the user nothing — "Bash" on its own is indistinguishable
 * from every other shell call in the conversation — so this reaches for the thing
 * being acted on: the command, then the path, then the query, then the URL.
 */
function toolSpecific(detail: ToolCallDetail): string | null {
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "worktree_setup":
      return detail.worktreePath;
    case "sub_agent":
      return detail.description ?? detail.subAgentType ?? null;
    case "plan":
      return firstLine(detail.text);
    case "plain_text":
      return detail.text ? firstLine(detail.text) : (detail.label ?? null);
    case "unknown":
      return unknownSpecific(detail.input);
    default:
      return null;
  }
}

/**
 * Providers we don't have a typed detail for still put the interesting string in a
 * conventionally named field, so probe the same keys the permission summary does.
 */
const UNKNOWN_DETAIL_KEYS = ["command", "file_path", "filePath", "path", "query", "url"];

function unknownSpecific(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of UNKNOWN_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function toolEntry(item: Extract<AgentTimelineItem, { type: "tool_call" }>): WearTranscriptEntry {
  const specific = toolSpecific(item.detail);
  const trimmed = specific ? normalizeLine(specific) : "";
  const line = trimmed ? `${item.name}: ${trimmed}` : item.name;

  // The suffix is reserved out of the budget rather than appended after capping, so
  // " (failed)" can never be the part that gets truncated away — it's the most
  // important word in the line — while the whole entry still honours the cap.
  const text =
    item.status === "failed"
      ? `${cap(line, MAX_TOOL_LENGTH - FAILED_SUFFIX.length)}${FAILED_SUFFIX}`
      : cap(line, MAX_TOOL_LENGTH);

  return { kind: "tool", text };
}

/**
 * Project one timeline item, or null for the kinds the watch doesn't show.
 *
 * Reasoning, todos and compaction are all dropped: they are either long, internal,
 * or purely structural, and none of them is something you read on a wrist.
 */
function projectItem(item: AgentTimelineItem): WearTranscriptEntry | null {
  switch (item.type) {
    case "user_message": {
      const text = cap(normalizeProse(item.text), MAX_MESSAGE_LENGTH);
      return text ? { kind: "user", text } : null;
    }
    case "assistant_message": {
      const text = cap(normalizeProse(item.text), MAX_MESSAGE_LENGTH);
      return text ? { kind: "assistant", text } : null;
    }
    case "tool_call":
      return toolEntry(item);
    case "error": {
      const text = cap(normalizeProse(item.message), MAX_ERROR_LENGTH);
      return text ? { kind: "error", text } : null;
    }
    default:
      return null;
  }
}

/**
 * Whether this item will survive projection into a visible entry.
 *
 * Exists so the fetch loop can budget its paging in entries the user will actually
 * see. Deliberately defined as "projection kept it" rather than a second list of
 * kinds: a duplicated list would drift the moment a kind is added or dropped, and a
 * reasoning-heavy history would silently start paging wrong.
 */
export function isTranscriptEntry(item: AgentTimelineItem): boolean {
  return projectItem(item) !== null;
}

/**
 * Build the transcript the watch renders.
 *
 * `truncated` is the honest answer to "is this the whole conversation?", and is set
 * by any of the three ways history can be lost: the daemon has older pages, the
 * entry cap dropped some, or the byte cap did.
 */
export function buildWearTranscript(input: WearTranscriptInput, now: number): WearTranscript {
  const projected = input.items
    .map(projectItem)
    .filter((entry): entry is WearTranscriptEntry => entry !== null);

  let entries = projected.slice(-MAX_TRANSCRIPT_ENTRIES);
  let truncated = input.hasOlder || entries.length < projected.length;

  const build = (): WearTranscript => ({
    v: WEAR_PROTOCOL_VERSION,
    agentId: input.agentId,
    serverId: input.serverId,
    updatedAt: now,
    entries,
    truncated,
  });

  // Drop from the front until the serialised payload fits. Measuring the real JSON
  // is the only honest check: entry counts say nothing about how big a payload is.
  while (entries.length > 0 && utf8ByteLength(JSON.stringify(build())) > MAX_TRANSCRIPT_BYTES) {
    entries = entries.slice(1);
    truncated = true;
  }

  return build();
}
