import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
  type TimelineFetchClient,
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
  client: TimelineFetchClient,
  agentId: string,
  options?: {
    timeoutMs?: number;
    tailCount?: number;
    matches?: (item: AgentTimelineItem) => boolean;
  },
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({
    client,
    agentId,
    timeoutMs: options?.timeoutMs,
    tailCount: options?.tailCount,
    matches: options?.matches,
  });
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

export function parseTailCount(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type AgentLogsPlan =
  | {
      isValid: true;
      tailCount: number | undefined;
      shouldConnect: boolean;
      shouldFetchInitialHistory: boolean;
    }
  | { isValid: false };

export function planAgentLogsRequest(options: AgentLogsOptions): AgentLogsPlan {
  const tailCount = parseTailCount(options.tail);
  if (tailCount === null) {
    return { isValid: false };
  }
  return {
    isValid: true,
    tailCount,
    shouldConnect: options.follow === true || tailCount !== 0,
    shouldFetchInitialHistory: tailCount !== 0,
  };
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

  const plan = planAgentLogsRequest(options);
  if (!plan.isValid) {
    console.error(`Error: Invalid --tail value: ${options.tail}`);
    console.error("Usage: --tail <n> (where n is >= 0)");
    process.exit(1);
  }
  if (!plan.shouldConnect) {
    return;
  }

  const host = getDaemonHost({ host: options.host });
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

    if (options.follow) {
      await runFollowMode(
        client,
        resolvedId,
        options,
        plan.tailCount,
        plan.shouldFetchInitialHistory,
      );
      return;
    }

    const timelineItems = await fetchAgentTimelineItems(client, resolvedId, {
      tailCount: plan.tailCount,
      ...(options.filter ? { matches: (item) => matchesFilter(item, options.filter) } : {}),
    });
    await client.close();

    const transcript = formatAgentActivityTranscript(timelineItems, plan.tailCount);
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
  requestedTailCount: number | undefined,
  shouldFetchInitialHistory: boolean,
): Promise<void> {
  const DEFAULT_FOLLOW_TAIL = 10;
  const tailCount = requestedTailCount ?? DEFAULT_FOLLOW_TAIL;

  let existingItems: AgentTimelineItem[] = [];
  if (shouldFetchInitialHistory) {
    try {
      existingItems = await fetchAgentTimelineItems(client, agentId, {
        timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
        tailCount,
        ...(options.filter ? { matches: (item) => matchesFilter(item, options.filter) } : {}),
      });
    } catch (error) {
      console.warn("Warning: failed to fetch existing timeline", error);
    }
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
      // Print each timeline item as it arrives using the curator format
      const transcript = formatAgentActivityTranscript([item]);
      if (transcript !== NO_ACTIVITY_MESSAGE) {
        console.log(transcript);
      }
    }
  });

  // Wait for interrupt
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      unsubscribe();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });

  await client.close();
}
