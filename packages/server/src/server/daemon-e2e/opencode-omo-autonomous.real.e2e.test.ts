import { expect, test } from "vitest";

import type { SessionOutboundMessage } from "../messages.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createOpenCodeOmoRealRuntime } from "./opencode-omo-real-runtime.js";

const CHILD_TOKEN = "PASEO_OMO_CHILD_READY";
const ROOT_IDLE_TOKEN = "PASEO_OMO_ROOT_WAITING";
const FINAL_TOKEN = "PASEO_OMO_AUTONOMOUS_FINAL";

test("OpenCode remains idle while an OMO child works and completes the autonomous wake", async () => {
  const runtime = await createOpenCodeOmoRealRuntime();
  const collector = createMessageCollector(runtime.client);
  let passed = false;

  try {
    const modeId = await resolveSisyphusMode(runtime.client, runtime.workspace);
    const agent = await runtime.client.createAgent({
      provider: "opencode",
      cwd: runtime.workspace,
      title: "OpenCode OMO autonomous wake",
      model: runtime.model,
      modeId,
    });

    await runtime.client.sendMessage(
      agent.id,
      [
        "Use the OMO task tool exactly once with category quick and run_in_background=true.",
        `Tell the child: use bash to sleep 5, then return exactly ${CHILD_TOKEN}.`,
        `After the background task starts, reply exactly ${ROOT_IDLE_TOKEN} and stop.`,
        "When the background completion notification arrives, retrieve the task result with background_output.",
        `After confirming ${CHILD_TOKEN}, reply exactly ${FINAL_TOKEN}.`,
      ].join(" "),
    );

    const firstFinish = await runtime.client.waitForFinish(agent.id, 240_000);
    expect(firstFinish.status).toBe("idle");
    const firstTimeline = await runtime.client.fetchAgentTimeline(agent.id, { limit: 240 });
    expect(assistantTexts(firstTimeline.entries).join("\n")).toContain(ROOT_IDLE_TOKEN);

    const completedChild = await waitForCompletedChildWithToken(
      runtime.client,
      agent.id,
      CHILD_TOKEN,
    );

    const firstTerminal = firstTerminalIndex(collector.messages, agent.id);
    await waitForMessage(
      collector.messages,
      (message, index) =>
        index > firstTerminal && isAgentStreamEvent(message, agent.id, "turn_started"),
      "autonomous turn start",
    );
    const wakeStartIndex = collector.messages.findIndex(
      (message) =>
        isAgentStreamEvent(message, agent.id, "turn_started") &&
        collector.messages.indexOf(message) > firstTerminal,
    );
    await waitForMessage(
      collector.messages,
      (message, index) =>
        index > wakeStartIndex && isAgentStreamEvent(message, agent.id, "turn_completed"),
      "autonomous turn completion",
    );
    const autonomousTerminalIndex = collector.messages.findIndex(
      (message, index) =>
        index > wakeStartIndex && isAgentStreamEvent(message, agent.id, "turn_completed"),
    );
    const finalTimeline = await runtime.client.fetchAgentTimeline(agent.id, { limit: 320 });
    expect(assistantTexts(finalTimeline.entries).at(-1)?.trim()).toBe(FINAL_TOKEN);
    await waitForMessage(
      collector.messages,
      (message, index) =>
        index > autonomousTerminalIndex && isAgentStatus(message, agent.id, "idle"),
      "idle after autonomous final output",
    );
    const cancellationAfterWake = collector.messages
      .slice(wakeStartIndex, autonomousTerminalIndex + 1)
      .some((message) => isAgentStreamEvent(message, agent.id, "turn_canceled"));
    const rootRunningIndex = collector.messages.findIndex((message) =>
      isAgentStatus(message, agent.id, "running"),
    );
    const childRunningIndex = collector.messages.findIndex((message) =>
      isProviderSubagentStatus(message, agent.id, completedChild.id, "running"),
    );
    const rootIdleIndex = collector.messages.findIndex(
      (message, index) => index > childRunningIndex && isAgentStatus(message, agent.id, "idle"),
    );
    const childCompletedIndex = collector.messages.findIndex((message) =>
      isProviderSubagentStatus(message, agent.id, completedChild.id, "completed"),
    );
    expect(rootRunningIndex).toBeGreaterThan(-1);
    expect(childRunningIndex).toBeGreaterThan(rootRunningIndex);
    expect(rootIdleIndex).toBeGreaterThan(childRunningIndex);
    expect(childCompletedIndex).toBeGreaterThan(rootIdleIndex);
    expect(wakeStartIndex).toBeGreaterThan(-1);
    expect(autonomousTerminalIndex).toBeGreaterThan(wakeStartIndex);
    expect(cancellationAfterWake).toBe(false);
    passed = true;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Retained real-test artifacts: ${runtime.artifacts}`,
      { cause: error },
    );
  } finally {
    collector.unsubscribe();
    await runtime.close(passed);
  }
}, 600_000);

function assistantTexts(
  entries: Awaited<
    ReturnType<
      typeof import("../test-utils/daemon-client.js").DaemonClient.prototype.fetchAgentTimeline
    >
  >["entries"],
): string[] {
  return entries.flatMap((entry) =>
    entry.item.type === "assistant_message" ? [entry.item.text] : [],
  );
}

function isAgentStreamEvent(
  message: SessionOutboundMessage,
  agentId: string,
  eventType: "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled",
): boolean {
  return (
    message.type === "agent_stream" &&
    message.payload.agentId === agentId &&
    message.payload.event.type === eventType
  );
}

function isAgentStatus(
  message: SessionOutboundMessage,
  agentId: string,
  status: "running" | "idle",
): boolean {
  return (
    message.type === "agent_update" &&
    message.payload.kind === "upsert" &&
    message.payload.agent.id === agentId &&
    message.payload.agent.status === status
  );
}

function isProviderSubagentStatus(
  message: SessionOutboundMessage,
  parentAgentId: string,
  subagentId: string,
  status: "running" | "completed",
): boolean {
  return (
    message.type === "agent.provider_subagents.update" &&
    message.payload.kind === "upsert" &&
    message.payload.subagent.parentAgentId === parentAgentId &&
    message.payload.subagent.id === subagentId &&
    message.payload.subagent.status === status
  );
}

function firstTerminalIndex(messages: SessionOutboundMessage[], agentId: string): number {
  return messages.findIndex(
    (message) =>
      isAgentStreamEvent(message, agentId, "turn_completed") ||
      isAgentStreamEvent(message, agentId, "turn_failed") ||
      isAgentStreamEvent(message, agentId, "turn_canceled"),
  );
}

async function waitForCompletedChildWithToken(
  client: import("../test-utils/daemon-client.js").DaemonClient,
  parentAgentId: string,
  token: string,
): Promise<Awaited<ReturnType<typeof client.listProviderSubagents>>["subagents"][number]> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const { subagents } = await client.listProviderSubagents(parentAgentId);
    for (const subagent of subagents) {
      const timeline = await client.fetchProviderSubagentTimeline(parentAgentId, subagent.id, {
        direction: "tail",
        limit: 0,
      });
      if (
        subagent.status === "completed" &&
        (timeline.rows
          .flatMap((row) => (row.item.type === "assistant_message" ? [row.item.text] : []))
          .join("")
          .includes(token) ||
          timeline.rows.some(
            (row) =>
              row.item.type === "tool_call" &&
              row.item.detail.type === "shell" &&
              row.item.detail.output?.includes(token),
          ))
      ) {
        return subagent;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for completed OpenCode child output ${token}`);
}

async function waitForMessage(
  messages: SessionOutboundMessage[],
  predicate: (message: SessionOutboundMessage, index: number) => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (!messages.some(predicate)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function resolveSisyphusMode(
  client: import("../test-utils/daemon-client.js").DaemonClient,
  cwd: string,
): Promise<string> {
  const { modes } = await client.listProviderModes("opencode", { cwd });
  const matches = modes.filter((mode) => mode.label.toLowerCase().startsWith("sisyphus"));
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`Expected one OMO Sisyphus mode, received: ${JSON.stringify(modes)}`);
  }
  return matches[0].id;
}
