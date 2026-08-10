import type { Command } from "commander";

export function addAttachOptions(cmd: Command): Command {
  return cmd
    .description("Attach to a running agent's output stream")
    .argument("<id>", "Agent ID (or prefix)");
}
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import {
  fetchProjectedTimelineItems,
  LIVE_HISTORY_FETCH_TIMEOUT_MS,
} from "../../utils/timeline.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentStreamMessage,
  AgentUpdateMessage,
} from "@getpaseo/protocol/messages";

export interface AgentAttachOptions {
  host?: string;
  [key: string]: unknown;
}

export type AttachSignal = "SIGINT" | "SIGTERM";
export type AttachAgentState = Pick<AgentSnapshotPayload, "id" | "status" | "archivedAt">;
export type AttachAgentUpdate =
  | { kind: "upsert"; agent: AttachAgentState }
  | { kind: "remove"; agentId: string };

export interface AttachSessionClient {
  onAgentStream(listener: (agentId: string, event: AgentStreamEventPayload) => void): () => void;
  onAgentUpdate(listener: (update: AttachAgentUpdate) => void): () => void;
  startAgentUpdates(): Promise<void>;
  fetchAgent(agentId: string): Promise<AttachAgentState | null>;
  close(): Promise<void>;
}

export interface AttachSignalSource {
  on(signal: AttachSignal, listener: () => void): void;
  removeListener(signal: AttachSignal, listener: () => void): void;
}

interface RunAttachSessionInput {
  agentId: string;
  client: AttachSessionClient;
  signalSource: AttachSignalSource;
  fetchTimelineItems(): Promise<AgentTimelineItem[]>;
  printTimelineItem(item: AgentTimelineItem): void;
  printStreamEvent(event: AgentStreamEventPayload): void;
  warnTimeline(error: unknown): void;
  printDetach(): void;
}

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

function isAttachable(agent: AttachAgentState): boolean {
  if (agent.archivedAt) return false;
  return agent.status === "initializing" || agent.status === "running";
}

function isTerminalTurn(event: AgentStreamEventPayload): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

export async function runAttachSession(input: RunAttachSessionInput): Promise<void> {
  let completed = false;
  let closePromise: Promise<void> | null = null;
  let resolveCompletion: () => void = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  function complete(): void {
    if (completed) return;
    completed = true;
    resolveCompletion();
    void closeClient().catch(() => {});
  }

  function closeClient(): Promise<void> {
    closePromise ??= input.client.close();
    return closePromise;
  }

  function detach(): void {
    if (completed) return;
    input.printDetach();
    complete();
  }

  async function verifyTerminalState(): Promise<void> {
    try {
      const agent = await Promise.race([input.client.fetchAgent(input.agentId), completion]);
      if (!completed && (!agent || !isAttachable(agent))) complete();
    } catch {
      return;
    }
  }

  async function catchUpTimeline(): Promise<void> {
    try {
      const timelineItems = await Promise.race([input.fetchTimelineItems(), completion]);
      if (completed) return;
      for (const item of timelineItems ?? []) input.printTimelineItem(item);
    } catch (error) {
      if (!completed) input.warnTimeline(error);
    }
  }

  const unsubscribeLifecycle = input.client.onAgentStream((agentId, event) => {
    if (agentId !== input.agentId || !isTerminalTurn(event)) return;
    void verifyTerminalState();
  });
  const unsubscribeUpdates = input.client.onAgentUpdate((update) => {
    if (update.kind === "remove") {
      if (update.agentId === input.agentId) complete();
      return;
    }
    if (update.agent.id === input.agentId && !isAttachable(update.agent)) complete();
  });
  input.signalSource.on("SIGINT", detach);
  input.signalSource.on("SIGTERM", detach);
  let unsubscribeOutput: (() => void) | null = null;

  try {
    try {
      await Promise.race([input.client.startAgentUpdates(), completion]);
      if (!completed) {
        const readback = await Promise.race([input.client.fetchAgent(input.agentId), completion]);
        if (!completed && (!readback || !isAttachable(readback))) complete();
      }
    } catch (error) {
      if (!completed) throw error;
    }

    if (!completed) await catchUpTimeline();

    if (!completed) {
      unsubscribeOutput = input.client.onAgentStream((agentId, event) => {
        if (agentId === input.agentId) input.printStreamEvent(event);
      });
    }

    await completion;
  } finally {
    unsubscribeOutput?.();
    unsubscribeLifecycle();
    unsubscribeUpdates();
    input.signalSource.removeListener("SIGINT", detach);
    input.signalSource.removeListener("SIGTERM", detach);
    await closeClient();
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
  const host = getDaemonHost({ host: options.host });

  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo attach <id>");
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

  let closePromise: Promise<void> | null = null;
  function closeClient(): Promise<void> {
    closePromise ??= client.close();
    return closePromise;
  }

  try {
    const fetchResult = await client.fetchAgent({ agentId: id });
    if (!fetchResult) {
      console.error(`Error: No agent found matching: ${id}`);
      console.error("Use `paseo ls` to list available agents");
      await closeClient();
      process.exit(1);
    }
    const resolvedId = fetchResult.agent.id;

    // Print header
    console.log(`Attaching to agent ${resolvedId.substring(0, 7)}...`);
    console.log(`(Press Ctrl+C to detach)\n`);

    await runAttachSession({
      agentId: resolvedId,
      client: {
        onAgentStream(listener) {
          return client.on("agent_stream", (message: AgentStreamMessage) => {
            listener(message.payload.agentId, message.payload.event);
          });
        },
        onAgentUpdate(listener) {
          return client.on("agent_update", (message: AgentUpdateMessage) => {
            listener(message.payload);
          });
        },
        async startAgentUpdates() {
          await client.fetchAgents({ subscribe: {} });
        },
        async fetchAgent(agentId) {
          return (await client.fetchAgent({ agentId }))?.agent ?? null;
        },
        close() {
          return closeClient();
        },
      },
      signalSource: process,
      fetchTimelineItems() {
        return fetchProjectedTimelineItems({
          client,
          agentId: resolvedId,
          timeoutMs: LIVE_HISTORY_FETCH_TIMEOUT_MS,
        });
      },
      printTimelineItem,
      printStreamEvent,
      warnTimeline(error) {
        console.warn("Warning: failed to fetch existing timeline", error);
      },
      printDetach() {
        console.log("\n\nDetaching from agent...");
      },
    });
  } catch (err) {
    await closeClient().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to attach to agent: ${message}`);
    process.exit(1);
  }
}
