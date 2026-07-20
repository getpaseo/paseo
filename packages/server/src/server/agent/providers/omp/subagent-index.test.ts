import { describe, expect, test } from "vitest";

import { OmpSubagentIndex } from "./subagent-index.js";

describe("OMP provider subagent mapper", () => {
  test("maps lifecycle and progress frames to stable provider_subagent descriptors", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "explore",
        description: "Inspect files",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "upsert",
          id: "child-1",
          title: "explore",
          description: "Inspect files",
          status: "running",
          toolCallId: "task-1",
        },
      },
    ]);

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "running",
          resolvedModel: "openai-codex/gpt-5.5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "running",
        title: "explore · gpt-5.5 (openai-codex)",
      },
    });

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "completed",
          resolvedModel: "anthropic/claude-sonnet-5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "completed",
        title: "explore · claude-sonnet-5 (anthropic)",
      },
    });
  });

  test("maps child message events onto the descriptor timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child answer" }],
          },
        },
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "assistant_message",
            text: "Child answer",
            messageId: "omp-history-assistant-1",
          },
        },
      },
    ]);
  });

  test("maps aborted lifecycle status to canceled", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "task",
        status: "aborted",
        index: 0,
      })[0],
    ).toMatchObject({ event: { id: "child-1", status: "canceled" } });
  });

  test("hasRunning tracks in-flight OMP task children", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(index.hasRunning(parent)).toBe(false);

    index.handleLifecycle(parent, {
      id: "child-1",
      agent: "explore",
      status: "started",
      index: 0,
    });
    expect(index.hasRunning(parent)).toBe(true);

    index.handleLifecycle(parent, {
      id: "child-1",
      agent: "explore",
      status: "completed",
      index: 0,
    });
    expect(index.hasRunning(parent)).toBe(false);
  });

  test("reconcileSnapshots brings missed get_subagents state into the index", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.reconcileSnapshots(parent, [
        {
          id: "child-2",
          agent: "audit",
          status: "running",
          parentToolCallId: "task-9",
        },
      ]),
    ).toMatchObject([{ event: { id: "child-2", status: "running" } }]);
    expect(index.hasRunning(parent)).toBe(true);

    index.reconcileSnapshots(parent, [
      {
        id: "child-2",
        agent: "audit",
        status: "completed",
        parentToolCallId: "task-9",
      },
    ]);
    expect(index.hasRunning(parent)).toBe(false);
  });
});
