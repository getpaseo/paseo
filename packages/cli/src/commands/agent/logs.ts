import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
} from "../../utils/timeline.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamMessage } from "@getpaseo/protocol/messages";
import { curateAgentActivity } from "@getpaseo/server";

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

export async function fetchAgentTimelineItems(
  client: DaemonClient,
  agentId: string,
  options?: { timeoutMs?: number },
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({ client, agentId, timeoutMs: options?.timeoutMs });
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

function parseTailCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
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
  const host = getDaemonHost({ host: options.host });

  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo agent logs <id>");
    process.exit(1);
  }

  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Cannot connect to daemon at ${host}: ${message}`);
    console.error("Start the daemon with: paseo daemon start");
    process.exit(1);
  }

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
      await runFollowMode(client, resolvedId, options);
      return;
    }

    // Fetch timeline directly via cursor RPC.
    let timelineItems = await fetchAgentTimelineItems(client, resolvedId);

    // Apply filter
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter));
    }

    const tailCount = parseTailCount(options.tail);
    if (options.tail !== undefined && tailCount === undefined) {
      console.error(`Error: Invalid --tail value: ${options.tail}`);
      console.error("Usage: --tail <n> (where n is >= 0)");
      await client.close().catch(() => {});
      process.exit(1);
    }

    await client.close();

    // Use curateAgentActivity to format the transcript
    if (tailCount === 0) {
      return;
    }

    const transcript = formatAgentActivityTranscript(timelineItems, tailCount);
    console.log(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to get logs: ${message}`);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode(
  client: DaemonClient,
  agentId: string,
  options: AgentLogsOptions,
): Promise<void> {
  const DEFAULT_FOLLOW_TAIL = 10;
  const tailCount = parseTailCount(options.tail) ?? DEFAULT_FOLLOW_TAIL;

  // First, get existing timeline.
  let existingItems: AgentTimelineItem[] = [];
  try {
    existingItems = await fetchAgentTimelineItems(client, agentId, {
      timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn("Warning: failed to fetch existing timeline", error);
  }

  // Apply filter to existing items
  if (options.filter) {
    existingItems = existingItems.filter((item) => matchesFilter(item, options.filter));
  }

  // Print existing transcript (tail-like behavior)
  if (tailCount > 0) {
    const existingTranscript = formatAgentActivityTranscript(existingItems, tailCount);
    if (existingTranscript !== NO_ACTIVITY_MESSAGE) {
      console.log(existingTranscript);
    }
  }

  // Subscribe to new events
  const tailLabel =
    tailCount === 0 ? "no history" : `last ${tailCount} entr${tailCount === 1 ? "y" : "ies"}`;
  console.log(`\n--- Following logs (${tailLabel}; Ctrl+C to stop) ---\n`);

  const writer = createFollowTranscriptWriter();

  const unsubscribe = client.on("agent_stream", (msg: unknown) => {
    const message = msg as AgentStreamMessage;
    if (message.type !== "agent_stream") return;
    if (message.payload.agentId !== agentId) return;

    if (message.payload.event.type === "timeline") {
      const item = message.payload.event.item;
      // Apply filter
      if (options.filter && !matchesFilter(item, options.filter)) {
        return;
      }
      writer.push(item, message.payload.event.turnId);
    }
  });

  // Wait for interrupt
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      writer.end();
      unsubscribe();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });

  await client.close();
}
