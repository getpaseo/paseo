import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-manager.js";
import { projectTimelineRows } from "../timeline-projection.js";
import { ClaudeAgentClient } from "./claude-agent.js";

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

type QueryMock = {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
};

function buildQueryMock(events: unknown[]): QueryMock {
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index >= events.length) {
        return { done: true, value: undefined };
      }
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>
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

function buildTailScenarioEvents(actionCount: number): unknown[] {
  const actionEvents = Array.from({ length: actionCount }, (_, index) => {
    const actionNumber = index + 1;
    return {
      type: "stream_event",
      parent_tool_use_id: "task-tail-1",
      event: {
        type: "content_block_start",
        index: actionNumber,
        content_block: {
          type: "tool_use",
          id: `sub-read-${actionNumber}`,
          name: "Read",
          input: {
            file_path: `file-${actionNumber}.md`,
          },
        },
      },
    };
  });

  return [
    {
      type: "system",
      subtype: "init",
      session_id: "sidechain-tail-session",
      permissionMode: "default",
      model: "opus",
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "task-tail-1",
          name: "Task",
          input: {
            subagent_type: "Explore",
            description: "Tail latest sub-agent activity",
          },
        },
      },
    },
    ...actionEvents,
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-tail-1",
            tool_name: "Task",
            content: "done",
            is_error: false,
          },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
      total_cost_usd: 0,
    },
  ];
}

describe("ClaudeAgentSession sub-agent sidechain updates", () => {
  const logger = createTestLogger();

  beforeEach(() => {
    const largeOldText = "VERY_LARGE_OLD_STRING".repeat(50);
    sdkMocks.query.mockImplementation(() =>
      buildQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "sidechain-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "task-call-1",
              name: "Task",
              input: {
                subagent_type: "Explore",
                description: "Inspect repository structure",
              },
            },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: "task-call-1",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "sub-read-1",
              name: "Read",
              input: {
                file_path: "README.md",
              },
            },
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: "task-call-1",
          event: {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "sub-edit-1",
              name: "Edit",
              input: {
                file_path: "src/index.ts",
                old_string: largeOldText,
                new_string: "replacement",
              },
            },
          },
        },
        {
          type: "tool_progress",
          tool_use_id: "sub-edit-1",
          tool_name: "Edit",
          parent_tool_use_id: "task-call-1",
          elapsed_time_seconds: 1,
        },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "task-call-1",
                tool_name: "Task",
                content: "done",
                is_error: false,
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ])
    );
  });

  afterEach(() => {
    sdkMocks.query.mockReset();
  });

  test("accumulates lightweight sub_agent detail and preserves callId lifecycle collapse", async () => {
    const session = await new ClaudeAgentClient({ logger }).createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("delegate work"));
    await session.close();

    const timelineToolCalls = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "tool_call"
      )
      .map((event) => event.item)
      .filter((item) => item.callId === "task-call-1");

    expect(timelineToolCalls.length).toBeGreaterThanOrEqual(2);

    const subAgentUpdates = timelineToolCalls.filter(
      (item) => item.detail.type === "sub_agent"
    );
    expect(subAgentUpdates.length).toBeGreaterThanOrEqual(1);

    const latest = subAgentUpdates[subAgentUpdates.length - 1];
    expect(latest).toBeDefined();
    if (!latest || latest.detail.type !== "sub_agent") {
      throw new Error("expected sub_agent detail");
    }

    expect(latest.detail.subAgentType).toBe("Explore");
    expect(latest.detail.description).toBe("Inspect repository structure");
    expect(latest.detail.actions).toEqual([
      {
        index: 1,
        toolName: "Read",
        summary: "README.md",
      },
      {
        index: 2,
        toolName: "Edit",
        summary: "src/index.ts",
      },
    ]);
    expect(latest.detail.log).toContain("[Read] README.md");
    expect(latest.detail.log).toContain("[Edit] src/index.ts");
    expect(latest.detail.log).not.toContain("VERY_LARGE_OLD_STRING");

    const rows: AgentTimelineRow[] = timelineToolCalls.map((item, index) => ({
      seq: index + 1,
      timestamp: `2026-02-01T00:00:0${index}.000Z`,
      item,
    }));
    const projected = projectTimelineRows(rows, "claude", "projected");
    const projectedTaskCalls = projected.filter(
      (entry) => entry.item.type === "tool_call" && entry.item.callId === "task-call-1"
    );

    expect(projectedTaskCalls).toHaveLength(1);
  });

  test("tails sub-agent actions instead of dropping latest entries at cap", async () => {
    sdkMocks.query.mockImplementation(() => buildQueryMock(buildTailScenarioEvents(205)));

    const session = await new ClaudeAgentClient({ logger }).createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const events = await collectUntilTerminal(session.stream("delegate work"));
    await session.close();

    const timelineToolCalls = events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "tool_call"
      )
      .map((event) => event.item)
      .filter((item) => item.callId === "task-tail-1");
    const subAgentUpdates = timelineToolCalls.filter(
      (item) => item.detail.type === "sub_agent"
    );
    const latest = subAgentUpdates[subAgentUpdates.length - 1];
    expect(latest).toBeDefined();
    if (!latest || latest.detail.type !== "sub_agent") {
      throw new Error("expected sub_agent detail");
    }

    expect(latest.detail.actions).toHaveLength(200);
    expect(latest.detail.actions[0]).toEqual({
      index: 6,
      toolName: "Read",
      summary: "file-6.md",
    });
    expect(latest.detail.actions[199]).toEqual({
      index: 205,
      toolName: "Read",
      summary: "file-205.md",
    });

    expect(latest.detail.log).not.toContain("[Read] file-1.md");
    expect(latest.detail.log).not.toContain("[Read] file-5.md");
    expect(latest.detail.log).toContain("[Read] file-6.md");
    expect(latest.detail.log).toContain("[Read] file-205.md");
  });
});
