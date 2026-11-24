import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { waitForStop } from "../../utils/wait-for-stop.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
} from "../../utils/timeline.js";
import type {
  DaemonClient,
  FetchAgentTimelineCursor,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { curateAgentActivity } from "@getpaseo/server/agent-activity";

export function addLogsOptions(cmd: Command): Command {
  return cmd
    .description("View agent activity/timeline")
    .argument("<id>", "Agent ID (or prefix)")
    .option("-f, --follow", "Follow log output (streaming)")
    .option("--tail <n>", "Show last n entries")
    .option("--filter <type>", "Filter by event type (tools, text, errors, permissions)")
    .option("--since <time>", "Show logs since timestamp");
}

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean;
  tail?: string;
  filter?: string;
  since?: string;
}

// Logs command returns void - it outputs directly to console
export type AgentLogsResult = void;

export const NO_ACTIVITY_MESSAGE = "No activity to display.";

interface FetchAgentTimelineItemsOptions {
  timeoutMs?: number;
  sinceTimestampMs?: number;
}

interface FollowModeInput {
  client: DaemonClient;
  agentId: string;
  options: AgentLogsOptions;
  sinceTimestampMs: number | undefined;
}

export async function fetchAgentTimelineItems(
  client: DaemonClient,
  agentId: string,
  options?: FetchAgentTimelineItemsOptions,
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({
    client,
    agentId,
    timeoutMs: options?.timeoutMs,
    sinceTimestampMs: options?.sinceTimestampMs,
  });
}

function validateTimelinePage(
  page: FetchAgentTimelinePayload,
  cursor?: FetchAgentTimelineCursor,
): void {
  const start = page.startCursor;
  if (
    (page.hasOlder && !start) ||
    (start &&
      (start.epoch !== page.epoch ||
        !Number.isSafeInteger(start.seq) ||
        start.seq <= 0 ||
        (page.entries[0] !== undefined && start.seq > page.entries[0].seqStart) ||
        (cursor && start.seq >= cursor.seq)))
  ) {
    throw new Error("Invalid timeline cursor while reading history.");
  }
}

export async function fetchOneShotTimelineItems(
  client: Pick<DaemonClient, "fetchAgentTimeline">,
  agentId: string,
  sinceTimestampMs: number | undefined,
  tailCount: number | undefined,
): Promise<AgentTimelineItem[]> {
  if (tailCount === 0) return [];
  const pages: AgentTimelineItem[][] = [];
  let cursor: FetchAgentTimelineCursor | undefined;
  let epoch: string | undefined;
  let count = 0;
  let pageLimit = 200;
  for (;;) {
    const limit = Math.min(pageLimit, tailCount === undefined ? pageLimit : tailCount - count);
    let page: FetchAgentTimelinePayload;
    try {
      page = await client.fetchAgentTimeline(agentId, {
        direction: cursor ? "before" : "tail",
        ...(cursor ? { cursor } : {}),
        limit,
        projection: "projected",
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Logical message too large") throw error;
      if (limit === 1)
        throw new Error("A timeline page exceeds the transport size limit even at limit 1.", {
          cause: error,
        });
      pageLimit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    if (
      page.reset ||
      page.staleCursor ||
      page.gap ||
      (epoch !== undefined && page.epoch !== epoch)
    ) {
      throw new Error("Timeline changed while reading history; retry the command.");
    }
    epoch = page.epoch;
    validateTimelinePage(page, cursor);
    const entries = page.entries.filter(
      (entry) => sinceTimestampMs === undefined || Date.parse(entry.timestamp) >= sinceTimestampMs,
    );
    pages.push(entries.map((entry) => entry.item));
    count += entries.length;
    if (!page.hasOlder || (tailCount !== undefined && count >= tailCount)) break;
    cursor = page.startCursor ?? undefined;
  }
  return pages.toReversed().flat();
}

export function formatAgentActivityTranscript(
  timelineItems: AgentTimelineItem[],
  tailCount?: number,
): string {
  if (tailCount === 0) {
    return "";
  }
  return curateAgentActivity(
    timelineItems,
    tailCount !== undefined ? { maxItems: tailCount } : undefined,
  );
}

/**
 * Picks the items `--tail` keeps, the same way the transcript does: the last n
 * timeline items, before any of them are dropped from the curated view.
 */
function selectTailItems(
  timelineItems: AgentTimelineItem[],
  tailCount?: number,
): AgentTimelineItem[] {
  if (tailCount === undefined) {
    return timelineItems;
  }
  if (tailCount === 0) {
    return [];
  }
  return timelineItems.slice(-tailCount);
}

function formatAgentLogsJson(
  agentId: string,
  timelineItems: AgentTimelineItem[],
  tailCount?: number,
): string {
  return JSON.stringify({ agentId, items: selectTailItems(timelineItems, tailCount) }, null, 2);
}

function usesJsonOutput(options: AgentLogsOptions): boolean {
  return options.json === true || options.format?.trim().toLowerCase() === "json";
}

type StreamingTextType = "assistant_message" | "reasoning";

const THOUGHT_PREFIX = "[Thought] ";

interface PendingStreamingText {
  type: StreamingTextType;
  turnId: string | undefined;
  messageId: string | undefined;
  buffer: string;
  emitted: boolean;
}

export interface FollowTranscriptWriter {
  push(item: AgentTimelineItem, turnId?: string): void;
  end(): void;
}

function lastNonWhitespaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Follow mode receives one streaming fragment per event, while the one-shot
 * transcript sees the whole timeline and merges consecutive assistant and
 * reasoning fragments with exact concatenation (`projectTimelineRows`). Printing
 * each fragment on its own line splits words at fragment boundaries and
 * reprints the reasoning prefix, so a chain of fragments is written as one
 * stream instead: text goes out as it arrives, and only the trailing whitespace
 * is held back so the message ends trimmed the way the transcript does.
 */
export function createFollowTranscriptWriter(
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
  filter?: string,
): FollowTranscriptWriter {
  let pending: PendingStreamingText | null = null;

  const emit = (chain: PendingStreamingText, text: string): void => {
    if (!chain.emitted) {
      chain.emitted = true;
      if (chain.type === "reasoning") {
        write(THOUGHT_PREFIX);
      }
    }
    write(text);
  };

  const flushContent = (chain: PendingStreamingText): void => {
    if (!chain.emitted) {
      chain.buffer = chain.buffer.replace(/^\s+/, "");
    }
    const lastContent = lastNonWhitespaceIndex(chain.buffer);
    if (lastContent < 0) {
      return;
    }
    emit(chain, chain.buffer.slice(0, lastContent + 1));
    chain.buffer = chain.buffer.slice(lastContent + 1);
  };

  const closePending = (): void => {
    const chain = pending;
    pending = null;
    if (!chain) {
      return;
    }
    const tail = chain.emitted ? chain.buffer.trimEnd() : chain.buffer.trim();
    if (tail) {
      emit(chain, tail);
    }
    if (chain.emitted) {
      write("\n");
    }
  };

  const continuesChain = (item: AgentTimelineItem, turnId: string | undefined): boolean => {
    if (!pending || pending.type !== item.type || pending.turnId !== turnId) {
      return false;
    }
    if (item.type !== "assistant_message") {
      return true;
    }
    return item.messageId === undefined || item.messageId === pending.messageId;
  };

  const startChain = (
    item: Extract<AgentTimelineItem, { type: StreamingTextType }>,
    turnId: string | undefined,
  ): PendingStreamingText => {
    closePending();
    const chain: PendingStreamingText = {
      type: item.type,
      turnId,
      messageId: item.type === "assistant_message" ? item.messageId : undefined,
      buffer: "",
      emitted: false,
    };
    pending = chain;
    return chain;
  };

  return {
    push(item, turnId) {
      if (!matchesFilter(item, filter)) {
        closePending();
        return;
      }
      if (item.type === "assistant_message" || item.type === "reasoning") {
        const chain = continuesChain(item, turnId) && pending ? pending : startChain(item, turnId);
        chain.buffer += item.text;
        flushContent(chain);
        return;
      }
      closePending();
      const transcript = formatAgentActivityTranscript([item]);
      if (transcript && transcript !== NO_ACTIVITY_MESSAGE) {
        write(`${transcript}\n`);
      }
    },
    end() {
      closePending();
    },
  };
}

/** Follow mode with `--json`: one JSON timeline item per line (NDJSON). */
export function createFollowJsonWriter(
  filter?: string,
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
): FollowTranscriptWriter {
  return {
    push(item) {
      if (matchesFilter(item, filter)) {
        write(`${JSON.stringify(item)}\n`);
      }
    },
    end() {},
  };
}

function parseTailCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseSinceTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const timestampMs = Date.parse(raw);
  if (Number.isNaN(timestampMs)) {
    throw {
      code: "INVALID_TIMESTAMP",
      message: `Invalid --since value: ${raw}`,
      details: "Use a timestamp such as 2026-01-01T00:00:00Z.",
    } satisfies CommandError;
  }
  return timestampMs;
}

/**
 * Check if a timeline item matches the filter type
 */
function matchesFilter(item: AgentTimelineItem, filter?: string): boolean {
  if (!filter) return true;

  const filterLower = filter.toLowerCase();
  const type = item.type.toLowerCase();

  switch (filterLower) {
    case "tools":
      return type === "tool_call";
    case "text":
      return type === "user_message" || type === "assistant_message" || type === "reasoning";
    case "errors":
      return type === "error";
    case "permissions":
      // Permissions might be in tool_call status or a separate event type
      return type.includes("permission");
    default:
      // If filter doesn't match predefined types, match against the actual type
      return type.includes(filterLower);
  }
}

export async function runLogsCommand(
  id: string,
  options: AgentLogsOptions,
  _command: Command,
): Promise<AgentLogsResult> {
  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo agent logs <id>");
    process.exit(1);
  }

  const sinceTimestampMs = parseSinceTimestamp(options.since);
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const fetchResult = await client.fetchAgent({ agentId: id });
    if (!fetchResult) {
      console.error(`Error: No agent found matching: ${id}`);
      console.error("Use `paseo ls` to list available agents");
      await client.close();
      process.exit(1);
    }
    const resolvedId = fetchResult.agent.id;

    // For follow mode, we stream events continuously
    if (options.follow) {
      if (options.tail !== undefined && parseTailCount(options.tail) === undefined) {
        console.error(`Error: Invalid --tail value: ${options.tail}`);
        console.error("Usage: --tail <n> (where n is >= 0)");
        await client.close().catch(() => {});
        process.exit(1);
      }
      await runFollowMode({
        client,
        agentId: resolvedId,
        options,
        sinceTimestampMs,
      });
      return;
    }

    const tailCount = parseTailCount(options.tail);
    if (options.tail !== undefined && tailCount === undefined) {
      console.error(`Error: Invalid --tail value: ${options.tail}`);
      console.error("Usage: --tail <n> (where n is >= 0)");
      await client.close().catch(() => {});
      process.exit(1);
    }

    // Filtered output must inspect every page: timestamps can be non-monotonic,
    // and text curation can merge entries after applying a filter.
    let fetchTailCount = tailCount;
    if (
      tailCount !== 0 &&
      (!usesJsonOutput(options) || options.filter || sinceTimestampMs !== undefined)
    ) {
      fetchTailCount = undefined;
    }
    let timelineItems = await fetchOneShotTimelineItems(
      client,
      resolvedId,
      sinceTimestampMs,
      fetchTailCount,
    );
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter));
    }

    await client.close();

    if (usesJsonOutput(options)) {
      console.log(formatAgentLogsJson(resolvedId, timelineItems, tailCount));
      return;
    }

    // Use curateAgentActivity to format the transcript
    if (tailCount === 0) {
      return;
    }

    const transcript = formatAgentActivityTranscript(timelineItems, tailCount);
    console.log(transcript);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to get logs: ${message}`);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode({
  client,
  agentId,
  options,
  sinceTimestampMs,
}: FollowModeInput): Promise<void> {
  // Observe shutdown before history writes can encounter a closed reader.
  // Keep an early stop resolved while subscription setup is in flight.
  const stopController = new AbortController();
  const stopped = waitForStop(stopController.signal);
  let unsubscribe: (() => void) | undefined;
  const json = usesJsonOutput(options);
  const writer = json
    ? createFollowJsonWriter(options.filter)
    : createFollowTranscriptWriter(undefined, options.filter);
  try {
    const DEFAULT_FOLLOW_TAIL = 10;
    const tailCount = parseTailCount(options.tail) ?? DEFAULT_FOLLOW_TAIL;

    // First, get existing timeline.
    let existingItems: AgentTimelineItem[] = [];
    try {
      const history = await Promise.race([
        fetchAgentTimelineItems(client, agentId, {
          timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
          sinceTimestampMs,
        }),
        stopped,
      ]);
      if (!history) return;
      existingItems = history;
    } catch (error) {
      console.warn("Warning: failed to fetch existing timeline", error);
    }

    // Apply filter to existing items
    if (options.filter) {
      existingItems = existingItems.filter((item) => matchesFilter(item, options.filter));
    }

    // Print existing transcript (tail-like behavior)
    if (json) {
      for (const item of selectTailItems(existingItems, tailCount)) {
        console.log(JSON.stringify(item));
      }
    } else if (tailCount > 0) {
      const existingTranscript = formatAgentActivityTranscript(existingItems, tailCount);
      if (existingTranscript !== NO_ACTIVITY_MESSAGE) {
        console.log(existingTranscript);
      }
    }

    // Subscribe to new events
    const tailLabel =
      tailCount === 0 ? "no history" : `last ${tailCount} entr${tailCount === 1 ? "y" : "ies"}`;

    // Keep stdout parseable in JSON mode: one timeline item per line, notices on stderr.
    const notice = json ? console.error : console.log;

    const subscription = client.subscribeAgentTimeline(agentId, (message) => {
      if (message.type === "agent.timeline.replacement") {
        writer.end();
        notice("\n[Timeline replaced; earlier output is no longer current]");
        return;
      }

      if (message.type === "agent.timeline.error") {
        writer.end();
        console.error(`Timeline observation stopped: ${message.payload.error}`);
        return;
      }
      if (message.type === "agent.timeline.subscription_restored") {
        writer.end();
        notice("\n[Reconnected; live output resumed. Events may have been missed.]");
        return;
      }
      if (message.payload.event.type === "timeline") {
        const matchesSince =
          sinceTimestampMs === undefined ||
          Date.parse(message.payload.timestamp) >= sinceTimestampMs;
        if (!matchesSince) {
          return;
        }
        const item = message.payload.event.item;
        writer.push(item, message.payload.event.turnId);
      } else if (
        message.payload.event.type === "turn_completed" ||
        message.payload.event.type === "turn_failed" ||
        message.payload.event.type === "turn_canceled"
      ) {
        writer.end();
      }
    });

    unsubscribe = subscription;
    const ready = await Promise.race([subscription.ready.then(() => true), stopped]);
    if (!ready) return;
    notice(`\n--- Following logs (${tailLabel}; Ctrl+C to stop) ---\n`);

    await stopped;
  } finally {
    stopController.abort();
    writer.end();
    unsubscribe?.();
    await client.close();
  }
}
