import type { EventSubscribeOutput, SessionInfo } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./opencode-v2/test-utils/test-opencode-v2-harness.js";

type ProviderSubagentUpsert = Extract<
  Extract<AgentStreamEvent, { type: "provider_subagent" }>["event"],
  { type: "upsert" }
>;
type ProviderSubagentTimeline = Extract<
  Extract<AgentStreamEvent, { type: "provider_subagent" }>["event"],
  { type: "timeline" }
>;

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function buildConfig(cwd: string): AgentSessionConfig {
  return {
    provider: "opencode-v2",
    cwd,
    model: TEST_MODEL,
  };
}

function v2Event(
  input: Omit<EventSubscribeOutput, "id" | "created" | "type"> & {
    type: EventSubscribeOutput["type"];
  },
): EventSubscribeOutput {
  return {
    id: "event-1",
    created: 1,
    ...input,
  } as EventSubscribeOutput;
}

function childSessionInfo(
  id: string,
  parentId: string,
  extra: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    parentID: parentId,
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace/repo" },
    ...extra,
  } as SessionInfo;
}

function textDeltaEvent(
  sessionId: string,
  assistantMessageId: string,
  ordinal: number,
  delta: string,
): EventSubscribeOutput {
  return v2Event({
    type: "session.text.delta",
    data: {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      ordinal,
      delta,
    },
  });
}

function executionSucceededEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.succeeded",
    data: { sessionID: sessionId },
  });
}

function executionFailedEvent(sessionId: string, message: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.failed",
    data: {
      sessionID: sessionId,
      error: { type: "provider.no-route", message },
    },
  });
}

function subagentSyntheticEvent(
  childId: string,
  state: "completed" | "error" | "cancelled",
  text: string,
): EventSubscribeOutput {
  return v2Event({
    type: "session.synthetic",
    data: {
      sessionID: "session-1",
      text,
      description: "Compute",
      metadata: { source: "subagent", childID: childId, agent: "general", state },
    },
  });
}

async function createSession(configure?: (openCode: TestOpenCodeV2Client) => void): Promise<{
  readonly session: Awaited<ReturnType<OpenCodeV2AgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeV2Client;
  readonly runtime: TestOpenCodeV2Harness;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession(buildConfig("/workspace/repo"));
  return { session, openCode, runtime };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

function upserts(events: AgentStreamEvent[]): ProviderSubagentUpsert[] {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
        event.type === "provider_subagent",
    )
    .filter((event) => event.event.type === "upsert")
    .map((event) => event.event);
}

function childTimelineEvents(
  events: AgentStreamEvent[],
  childId: string,
): ProviderSubagentTimeline[] {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> =>
        event.type === "provider_subagent",
    )
    .filter(
      (
        event,
      ): event is Extract<AgentStreamEvent, { type: "provider_subagent" }> & {
        event: ProviderSubagentTimeline;
      } => event.event.type === "timeline" && event.event.id === childId,
    )
    .map((event) => event.event);
}

function upsertFor(
  events: AgentStreamEvent[],
  childId: string,
): ProviderSubagentUpsert | undefined {
  const matches = upserts(events).filter((upsert) => upsert.id === childId);
  return matches[matches.length - 1];
}

describe("OpenCodeV2AgentSession subagents", () => {
  test("discovers child sessions via session.list({ parentID }) and surfaces an upsert", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => {
      expect(openCode.calls.sessionList).toContainEqual({ parentID: "session-1" });
      expect(upsertFor(events, "child-1")).toBeDefined();
    });
    expect(upsertFor(events, "child-1")).toMatchObject({
      id: "child-1",
      status: "running",
    });

    await session.close();
  });

  test("surfaces a completed child from a session.list outcome", async () => {
    const { session } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return {
            data: [childSessionInfo("child-1", "session-1", { outcome: "succeeded" })],
            cursor: {},
          };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());
    expect(upsertFor(events, "child-1")).toMatchObject({ id: "child-1", status: "completed" });

    await session.close();
  });

  test("surfaces a failed child from a session.list outcome", async () => {
    const { session } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return {
            data: [childSessionInfo("child-1", "session-1", { outcome: "failed" })],
            cursor: {},
          };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());
    expect(upsertFor(events, "child-1")).toMatchObject({ id: "child-1", status: "failed" });

    await session.close();
  });

  test("presents multiple subagents as distinct children", async () => {
    const { session } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return {
            data: [
              childSessionInfo("child-1", "session-1"),
              childSessionInfo("child-2", "session-1"),
            ],
            cursor: {},
          };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => {
      expect(upsertFor(events, "child-1")).toBeDefined();
      expect(upsertFor(events, "child-2")).toBeDefined();
    });
    const childIds = upserts(events).map((upsert) => upsert.id);
    expect(childIds).toContain("child-1");
    expect(childIds).toContain("child-2");

    await session.close();
  });

  test("reflects a designated agent and model on the subagent upsert", async () => {
    const { session } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return {
            data: [
              childSessionInfo("child-1", "session-1", {
                agent: "subagent",
                model: { id: "gpt-5", providerID: "openai" },
              }),
            ],
            cursor: {},
          };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());
    const upsert = upsertFor(events, "child-1");
    expect(upsert?.title).toBe("subagent");
    expect(upsert?.subtitle).toContain("subagent");

    await session.close();
  });

  test("hydrates a child timeline from message.list", async () => {
    const { session } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
      client.messageListImplementation = async (input) => {
        if (input.sessionID === "child-1") {
          return {
            data: [
              {
                id: "msg_child_1",
                type: "assistant",
                agent: "general",
                model: { id: "gpt-5", providerID: "openai" },
                time: { created: 1, completed: 2 },
                content: [{ type: "text", text: "Child says hi" }],
              },
            ],
            cursor: {},
          };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await waitFor(() => {
      expect(upsertFor(events, "child-1")).toBeDefined();
      expect(childTimelineEvents(events, "child-1").length).toBeGreaterThan(0);
    });
    const timeline = childTimelineEvents(events, "child-1");
    const items = timeline.map((entry) => entry.item);
    expect(items.some((item) => item.type === "assistant_message")).toBe(true);

    await session.close();
  });

  test("routes live child events into provider_subagent timeline rows", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());

    openCode.emitEvent(textDeltaEvent("child-1", "assistant-child-1", 0, "Child working"));
    await waitFor(() => expect(childTimelineEvents(events, "child-1").length).toBeGreaterThan(0));

    const items = childTimelineEvents(events, "child-1").map((entry) => entry.item);
    const assistant = items.find(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message",
    );
    expect(assistant?.text).toBe("Child working");

    await session.close();
  });

  test("marks a child completed on session.execution.succeeded", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());

    openCode.emitEvent(executionSucceededEvent("child-1"));
    await waitFor(() => expect(upsertFor(events, "child-1")?.status).toBe("completed"));

    await session.close();
  });

  test("marks a child failed on session.execution.failed", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());

    openCode.emitEvent(executionFailedEvent("child-1", "Subagent blew up"));
    await waitFor(() => expect(upsertFor(events, "child-1")?.status).toBe("failed"));

    await session.close();
  });

  test("marks a child canceled on session.execution.interrupted", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());

    openCode.emitEvent(
      v2Event({
        type: "session.execution.interrupted",
        data: { sessionID: "child-1", reason: "user" },
      }),
    );
    await waitFor(() => expect(upsertFor(events, "child-1")?.status).toBe("canceled"));

    await session.close();
  });

  test("interrupt during a subagent settles parent and child", async () => {
    const { session, openCode } = await createSession((client) => {
      client.sessionListImplementation = async (input) => {
        if (input.parentID === "session-1") {
          return { data: [childSessionInfo("child-1", "session-1")], cursor: {} };
        }
        return { data: [], cursor: {} };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await waitFor(() => expect(upsertFor(events, "child-1")).toBeDefined());

    await session.startTurn("Run a long task");
    await session.interrupt();

    expect(openCode.calls.sessionInterrupt).toContainEqual({
      sessionID: "session-1",
      continue: true,
    });
    expect(openCode.calls.sessionInterrupt).toContainEqual({ sessionID: "child-1" });

    await session.close();
  });

  test("completes a subagent from a session.synthetic with subagent source", async () => {
    const { session, openCode } = await createSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    openCode.emitEvent(
      subagentSyntheticEvent(
        "child-9",
        "completed",
        '<subagent sessionID="child-9">\n4\n</subagent>',
      ),
    );
    await waitFor(() => expect(upsertFor(events, "child-9")).toBeDefined());
    expect(upsertFor(events, "child-9")).toMatchObject({
      id: "child-9",
      status: "completed",
    });

    await session.close();
  });

  test("surfaces a failed subagent from a session.synthetic with error state", async () => {
    const { session, openCode } = await createSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    openCode.emitEvent(
      subagentSyntheticEvent(
        "child-9",
        "error",
        '<subagent sessionID="child-9">\nBoom\n</subagent>',
      ),
    );
    await waitFor(() => expect(upsertFor(events, "child-9")).toBeDefined());
    expect(upsertFor(events, "child-9")).toMatchObject({
      id: "child-9",
      status: "failed",
    });

    await session.close();
  });
});
