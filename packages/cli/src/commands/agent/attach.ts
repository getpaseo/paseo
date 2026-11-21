import type { Command } from "commander";

export function addAttachOptions(cmd: Command): Command {
  return cmd
    .description("Attach to a running agent's output stream")
    .argument("<id>", "Agent ID (or prefix)");
}
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions } from "../../output/index.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createFollowJsonWriter } from "./logs.js";
import { waitForStop } from "../../utils/wait-for-stop.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
} from "../../utils/timeline.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";

export interface AgentAttachOptions extends CommandOptions {}

/**
 * Format and print a timeline item to the terminal
 */
function printTimelineItem(item: AgentTimelineItem): void {
  switch (item.type) {
    case "assistant_message":
      // Print assistant text directly
      process.stdout.write(item.text);
      break;

    case "reasoning":
      // Print reasoning in a muted color if available
      console.log(`\n[Reasoning] ${item.text}`);
      break;

    case "tool_call": {
      const toolName = item.name;
      const status = item.status ?? "started";
      console.log(`\n[Tool: ${toolName}] ${status}`);
      break;
    }

    case "todo": {
      const completed = item.items.filter((i) => i.completed).length;
      const total = item.items.length;
      console.log(`\n[Todo] ${completed}/${total} completed`);
      break;
    }

    case "error":
      console.error(`\n[Error] ${item.message}`);
      break;

    case "user_message":
      console.log(`\n[User] ${item.text}`);
      break;

    default:
      // Unknown item type, skip
      break;
  }
}

/**
 * Format and print a stream event to the terminal
 */
function printStreamEvent(event: AgentStreamEventPayload): void {
  switch (event.type) {
    case "timeline":
      // Print the timeline item
      printTimelineItem(event.item);
      break;

    case "permission_requested":
      console.log(`\n[Permission Required] ${event.request.name}`);
      if (event.request.description) {
        console.log(`  ${event.request.description}`);
      }
      break;

    case "permission_resolved":
      console.log(`\n[Permission ${event.resolution.behavior}]`);
      break;

    case "turn_failed":
      console.error(`\n[Turn Failed] ${event.error}`);
      break;

    case "attention_required":
      console.log(`\n[Attention Required: ${event.reason}]`);
      break;

    default:
      // Other event types are internal
      break;
  }
}

/**
 * Attach to a running agent's output stream
 */
export async function runAttachCommand(
  id: string,
  options: AgentAttachOptions,
  _command: Command,
): Promise<void> {
  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo attach <id>");
    process.exit(1);
  }

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

    if (options.json === true || options.format?.trim().toLowerCase() === "json") {
      await runJsonAttach(
        {
          history: () =>
            fetchProjectedTimelineItems({
              client,
              agentId: resolvedId,
              timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
            }),
          subscribe: (handler) => client.subscribeAgentTimeline(resolvedId, handler),
          close: () => client.close(),
        },
        resolvedId,
      );
      return;
    }

    // Print header
    console.log(`Fetching history for agent ${resolvedId.substring(0, 7)}...`);
    console.log(`(Press Ctrl+C to detach)\n`);

    // Print existing output from timeline fetch.
    try {
      const timelineItems = await fetchProjectedTimelineItems({
        client,
        agentId: resolvedId,
        timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
      });
      for (const item of timelineItems) {
        printTimelineItem(item);
      }
    } catch (error) {
      console.warn("Warning: failed to fetch existing timeline", error);
    }

    // Subscribe to new events
    const unsubscribe = client.subscribeAgentTimeline(resolvedId, (message) => {
      if (message.type === "agent.timeline.replacement") {
        console.log("\n[Timeline replaced; earlier output is no longer current]");
      } else if (message.type === "agent.timeline.subscription_restored") {
        console.log("\n[Reconnected; live output resumed. Events may have been missed.]");
      } else if (message.type === "agent.timeline.error") {
        console.error(`Timeline observation stopped: ${message.payload.error}`);
      } else {
        printStreamEvent(message.payload.event);
      }
    });

    await unsubscribe.ready;
    console.log(`Attached to agent ${resolvedId.substring(0, 7)}.`);

    await waitForStop();
    console.log("\n\nDetaching from agent...");
    unsubscribe();
    await client.close();
  } catch (err) {
    await client.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to attach to agent: ${message}`);
    process.exit(1);
  }
}

/** JSON attach owns shutdown before history can write to a closed reader. */
export interface JsonAttachPort {
  history(): Promise<AgentTimelineItem[]>;
  subscribe: (
    handler: Parameters<DaemonClient["subscribeAgentTimeline"]>[1],
  ) => ReturnType<DaemonClient["subscribeAgentTimeline"]>;
  close(): Promise<void>;
  write?: (chunk: string) => void;
  notice?: (message: string, error?: unknown) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
}

export async function runJsonAttach(port: JsonAttachPort, agentId: string): Promise<void> {
  const controller = new AbortController();
  const stopped = (port.wait ?? waitForStop)(controller.signal);
  const writer = createFollowJsonWriter(undefined, port.write);
  const notice = port.notice ?? console.error;
  let unsubscribe: (() => void) | undefined;
  try {
    notice(`Fetching history for agent ${agentId.substring(0, 7)}...`);
    notice(`(Press Ctrl+C to detach)\n`);
    try {
      const history = await Promise.race([port.history(), stopped]);
      if (!history) return;
      for (const item of history) writer.push(item);
    } catch (error) {
      notice("Warning: failed to fetch existing timeline", error);
    }
    const subscription = port.subscribe((message) => {
      if (message.type === "agent.timeline.replacement") {
        notice("\n[Timeline replaced; earlier output is no longer current]");
      } else if (message.type === "agent.timeline.subscription_restored") {
        notice("\n[Reconnected; live output resumed. Events may have been missed.]");
      } else if (message.type === "agent.timeline.error") {
        notice(`Timeline observation stopped: ${message.payload.error}`);
      } else if (message.payload.event.type === "timeline") {
        writer.push(message.payload.event.item);
      }
    });
    unsubscribe = subscription;
    const ready = await Promise.race([subscription.ready.then(() => true), stopped]);
    if (!ready) return;
    notice(`Attached to agent ${agentId.substring(0, 7)}.`);
    await stopped;
    notice("\n\nDetaching from agent...");
  } finally {
    controller.abort();
    writer.end();
    unsubscribe?.();
    await port.close();
  }
}
