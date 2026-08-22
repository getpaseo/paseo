import type { SessionNotification } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { DEFAULT_ACP_CAPABILITIES } from "./acp-agent.js";
import { TraeACPAgentSession } from "./trae-acp-agent.js";

const ROOT_ID = "parent-thread";
const CHILD_ID = "child-thread";
const SPAWN_ID = "call-spawn";
const message = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text },
});

function createSession(): { session: TraeACPAgentSession; events: AgentStreamEvent[] } {
  const session = new TraeACPAgentSession(
    { provider: "acp", cwd: "/tmp/paseo-trae-acp-test" },
    {
      provider: "acp",
      logger: createTestLogger(),
      defaultCommand: ["traecli", "acp", "serve"],
      defaultModes: [],
      capabilities: DEFAULT_ACP_CAPABILITIES,
    },
  );
  asInternals<{ sessionId: string | null }>(session).sessionId = ROOT_ID;
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  events.length = 0;
  return { session, events };
}

function notification(
  update: SessionNotification["update"],
  traex?: Record<string, unknown>,
): SessionNotification {
  return {
    sessionId: ROOT_ID,
    update,
    ...(traex ? { _meta: { traex } } : {}),
  };
}

const spawn = () =>
  notification({
    sessionUpdate: "tool_call",
    toolCallId: SPAWN_ID,
    title: "Spawn Bacon",
    kind: "think",
    status: "in_progress",
    content: [],
    _meta: {
      traex: {
        type: "subagent_control",
        action: "spawn_agent",
        parentThreadId: ROOT_ID,
        parentToolCallId: SPAWN_ID,
        childThreadId: CHILD_ID,
        agentNickname: "Bacon",
      },
    },
  });

const child = (update: SessionNotification["update"]) =>
  notification(update, {
    type: "subagent_child",
    parentThreadId: ROOT_ID,
    childThreadId: CHILD_ID,
    parentToolCallId: SPAWN_ID,
    childTurnId: "child-turn",
  });

function childEvents(events: AgentStreamEvent[]) {
  return events.flatMap((event) => (event.type === "provider_subagent" ? [event.event] : []));
}

test("routes Trae spawn and child assistant/reasoning updates", async () => {
  const { session, events } = createSession();
  await session.sessionUpdate(spawn());
  await session.sessionUpdate(child(message("CHILD_MESSAGE")));
  await session.sessionUpdate(
    child({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "CHILD_REASONING" },
    }),
  );

  expect(events.filter((event) => event.type === "timeline")).toEqual([
    expect.objectContaining({
      item: expect.objectContaining({ type: "tool_call", callId: SPAWN_ID }),
    }),
  ]);
  expect(childEvents(events)).toEqual([
    { type: "upsert", id: CHILD_ID, description: "Bacon", toolCallId: SPAWN_ID },
    { type: "upsert", id: CHILD_ID, toolCallId: SPAWN_ID },
    {
      type: "timeline",
      id: CHILD_ID,
      item: { type: "assistant_message", text: "CHILD_MESSAGE", messageId: "child-turn" },
    },
    { type: "upsert", id: CHILD_ID, toolCallId: SPAWN_ID },
    { type: "timeline", id: CHILD_ID, item: { type: "reasoning", text: "CHILD_REASONING" } },
  ]);
});

test("routes child output that arrives before the spawn descriptor", async () => {
  const { session, events } = createSession();
  await session.sessionUpdate(child(message("EARLY_CHILD")));
  await session.sessionUpdate(spawn());

  expect(childEvents(events)).toEqual([
    { type: "upsert", id: CHILD_ID, toolCallId: SPAWN_ID },
    {
      type: "timeline",
      id: CHILD_ID,
      item: { type: "assistant_message", text: "EARLY_CHILD", messageId: "child-turn" },
    },
    { type: "upsert", id: CHILD_ID, description: "Bacon", toolCallId: SPAWN_ID },
  ]);
});

test("fails closed for malformed or unsupported tagged child updates", async () => {
  const { session, events } = createSession();
  await session.sessionUpdate(
    notification(message("MISSING_CHILD_ID"), {
      type: "subagent_child",
      parentThreadId: ROOT_ID,
      parentToolCallId: SPAWN_ID,
    }),
  );
  await session.sessionUpdate(
    notification(message("MISSING_TOOL_ID"), {
      type: "subagent_child",
      parentThreadId: ROOT_ID,
      childThreadId: CHILD_ID,
    }),
  );
  await session.sessionUpdate(
    child({
      sessionUpdate: "plan",
      entries: [{ content: "CHILD_PLAN", priority: "medium", status: "in_progress" }],
    }),
  );

  expect(events).toEqual([]);
});
