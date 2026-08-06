import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

/**
 * A backgrounded Task subagent emits NO frames carrying parent_tool_use_id — verified against
 * Claude Code 2.1.220. Everything keyed off that field therefore sees nothing for one: no
 * descriptor, no timeline, and a Task card in the parent transcript with no type or task on it.
 *
 * The task protocol still announces the subagent, so these assert that a background child is
 * visible on both surfaces from its declaration alone.
 */

const queryFactory = vi.fn();

function buildQueryMock(events: unknown[]) {
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index >= events.length) return { done: true, value: undefined };
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// No frame carries parent_tool_use_id: that is the defining shape of a background subagent.
const BACKGROUND_SUBAGENT_STREAM = [
  { type: "system", subtype: "init", session_id: "bg-session", permissionMode: "default" },
  {
    type: "system",
    subtype: "task_started",
    task_id: "aa482d02957fe96c8",
    tool_use_id: "toolu_01TVF5JXom1yoZVoiaEWAoUV",
    task_type: "local_agent",
    subagent_type: "general-purpose",
    description: "Reply with banana",
    prompt: "Reply with just the word: banana",
  },
  {
    type: "system",
    subtype: "task_updated",
    task_id: "aa482d02957fe96c8",
    patch: { status: "completed" },
  },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  },
];

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

describe("background Claude subagents", () => {
  afterEach(() => {
    queryFactory.mockReset();
  });

  async function runStream(): Promise<AgentStreamEvent[]> {
    queryFactory.mockImplementation(() => buildQueryMock(BACKGROUND_SUBAGENT_STREAM));
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events = await collectUntilTerminal(streamSession(session, "delegate work"));
    await session.close();
    return events;
  }

  test("appears in the subagents track despite emitting no sidechain frames", async () => {
    const upserts = (await runStream())
      .filter((event) => event.type === "provider_subagent")
      .map((event) => event.event)
      .filter((event) => event.type === "upsert");

    expect(upserts[0]).toMatchObject({
      id: "toolu_01TVF5JXom1yoZVoiaEWAoUV",
      toolCallId: "toolu_01TVF5JXom1yoZVoiaEWAoUV",
      title: "general-purpose",
      description: "Reply with banana",
    });
    expect(upserts.at(-1)).toMatchObject({ status: "completed" });
  });

  test("opens the child timeline with the prompt it was given", async () => {
    const firstTimelineItem = (await runStream())
      .filter((event) => event.type === "provider_subagent")
      .map((event) => event.event)
      .find((event) => event.type === "timeline");

    expect(firstTimelineItem).toMatchObject({
      id: "toolu_01TVF5JXom1yoZVoiaEWAoUV",
      item: { type: "user_message", text: "Reply with just the word: banana" },
    });
  });

  test("exposes a workflow through the same provider-subagent stream as its child frames", async () => {
    queryFactory.mockImplementation(() =>
      buildQueryMock([
        { type: "system", subtype: "init", session_id: "bg-session", permissionMode: "default" },
        {
          type: "assistant",
          message: {
            model: "claude-opus-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_workflow",
                name: "Workflow",
                input: { workflow: "spec" },
              },
            ],
          },
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "wf-1",
          tool_use_id: "toolu_workflow",
          task_type: "local_workflow",
          workflow_name: "spec",
          description: "Run the spec workflow",
        },
        {
          type: "assistant",
          parent_tool_use_id: "toolu_workflow",
          message: { model: "claude-opus-5", content: [{ type: "text", text: "working" }] },
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "wf-1",
          patch: { status: "completed" },
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "wf-1",
          tool_use_id: "toolu_workflow",
          status: "completed",
          summary: "Workflow completed",
          output_file: "/tmp/workflow.output",
        },
        { type: "result", subtype: "success", usage: {}, total_cost_usd: 0 },
      ]),
    );
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const events = await collectUntilTerminal(streamSession(session, "run the workflow"));
    await session.close();

    const providerEvents = events.filter((event) => event.type === "provider_subagent");
    expect(providerEvents[0]).toMatchObject({
      event: {
        type: "upsert",
        id: "toolu_workflow",
        title: "Workflow",
        description: "Run the spec workflow",
        status: "running",
      },
    });
    expect(providerEvents).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "timeline",
          id: "toolu_workflow",
          item: expect.objectContaining({ type: "assistant_message", text: "working" }),
        }),
      }),
    );
    expect(providerEvents.at(-1)).toMatchObject({
      event: { type: "upsert", id: "toolu_workflow", status: "completed" },
    });

    const parentCards = events
      .filter((event) => event.type === "timeline")
      .map((event) => event.item)
      .filter((item) => item.type === "tool_call" && item.callId === "toolu_workflow");
    expect(parentCards).toHaveLength(1);
    expect(parentCards[0]).toMatchObject({
      type: "tool_call",
      name: "Workflow",
      callId: "toolu_workflow",
    });
    expect(parentCards[0]).not.toMatchObject({ detail: { type: "sub_agent" } });
    expect(
      events
        .filter((event) => event.type === "timeline")
        .map((event) => event.item)
        .find((item) => item.type === "tool_call" && item.name === "task_notification"),
    ).toBeUndefined();
  });

  test("labels the parent's Task card with the type and task", async () => {
    // Without this the card renders as a bare "Task": the tracker that normally supplies the
    // sub_agent detail never runs, because no frame carries parent_tool_use_id.
    const card = (await runStream())
      .filter((event) => event.type === "timeline")
      .map((event) => event.item)
      .find((item) => item.type === "tool_call" && item.detail?.type === "sub_agent");

    expect(card).toMatchObject({
      type: "tool_call",
      callId: "toolu_01TVF5JXom1yoZVoiaEWAoUV",
      detail: {
        type: "sub_agent",
        subAgentType: "general-purpose",
        description: "Reply with banana",
      },
    });
  });
});
