import { describe, expect, test } from "vitest";

import { OmpSubagentCardTracker, type OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

const PARENT_TOOL_CALL_ID = "task-1";
const SESSION_FILE = "/tmp/omp-task/EchoSubagent.jsonl";
const LIFECYCLE: OmpSubagentLifecyclePayload = {
  id: "EchoSubagent",
  agent: "task",
  description: "Run echo in subagent",
  status: "started",
  sessionFile: SESSION_FILE,
  parentToolCallId: PARENT_TOOL_CALL_ID,
  index: 0,
};
const PROGRESS: OmpSubagentProgressPayload[] = [
  {
    index: 0,
    agent: "task",
    task: "Run echo",
    parentToolCallId: PARENT_TOOL_CALL_ID,
    sessionFile: SESSION_FILE,
    progress: {
      id: "EchoSubagent",
      status: "running",
      recentTools: [{ tool: "bash", args: "echo subagent-hi", endMs: 1 }],
    },
  },
  {
    index: 0,
    agent: "task",
    task: "Run echo",
    parentToolCallId: PARENT_TOOL_CALL_ID,
    sessionFile: SESSION_FILE,
    progress: {
      id: "EchoSubagent",
      status: "running",
      recentTools: [
        { tool: "yield", args: "", endMs: 2 },
        { tool: "bash", args: "echo subagent-hi", endMs: 1 },
      ],
    },
  },
  {
    index: 0,
    agent: "task",
    task: "Run echo",
    parentToolCallId: PARENT_TOOL_CALL_ID,
    sessionFile: SESSION_FILE,
    progress: {
      id: "EchoSubagent",
      status: "completed",
      recentTools: [
        { tool: "yield", args: "", endMs: 2 },
        { tool: "bash", args: "echo subagent-hi", endMs: 1 },
      ],
    },
  },
];

class ManualScheduler implements OmpSubagentCardScheduler {
  private currentMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { dueMs: number; callback: () => void }>();

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { dueMs: this.currentMs + delayMs, callback });
    return { token: id };
  }

  clearTimeout(timer: { token: unknown }): void {
    if (typeof timer.token === "number") {
      this.timers.delete(timer.token);
    }
  }

  advance(ms: number): void {
    this.currentMs += ms;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueMs <= this.currentMs)
      .sort((left, right) => left[1].dueMs - right[1].dueMs);
    for (const [id, timer] of dueTimers) {
      if (this.timers.delete(id)) {
        timer.callback();
      }
    }
  }
}

describe("OmpSubagentCardTracker", () => {
  test("folds lifecycle and progress into one throttled sub-agent detail", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });
    tracker.handleLifecycle(LIFECYCLE);
    for (const payload of PROGRESS) {
      tracker.handleProgress(payload);
    }

    expect(emitted).toEqual([PARENT_TOOL_CALL_ID]);
    const detailBeforeTrailing = tracker.detailFor(PARENT_TOOL_CALL_ID, {
      type: "sub_agent",
      subAgentType: "task",
      description: "Task arg description wins",
      log: "",
    });
    expect(detailBeforeTrailing).toEqual({
      type: "sub_agent",
      subAgentType: "task",
      description: "Task arg description wins",
      childSessionId: SESSION_FILE,
      log: [
        "EchoSubagent started",
        "[bash] echo subagent-hi",
        "[yield]",
        "EchoSubagent completed",
      ].join("\n"),
    });

    scheduler.advance(500);

    expect(emitted).toEqual([PARENT_TOOL_CALL_ID, PARENT_TOOL_CALL_ID]);
  });

  test("aggregates batch progress streams into one index-prefixed log", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });

    tracker.handleLifecycle({
      id: "Explore",
      agent: "task",
      description: "Inspect files",
      status: "started",
      sessionFile: "/tmp/one.jsonl",
      parentToolCallId: "task.batch-1",
      index: 0,
    });
    scheduler.advance(600);
    tracker.handleProgress({
      index: 5,
      agent: "task",
      task: "Run tests",
      parentToolCallId: "task.batch-1",
      progress: {
        id: "Test",
        status: "running",
        description: "Run tests",
        recentTools: [{ tool: "bash", args: "npm test", endMs: 10 }],
      },
      sessionFile: "/tmp/two.jsonl",
    });

    expect(emitted).toEqual(["task.batch-1", "task.batch-1"]);
    expect(
      tracker.detailFor("task.batch-1", {
        type: "sub_agent",
        subAgentType: "batch",
        actions: [],
        log: "",
      }),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "batch",
      description: "Inspect files",
      childSessionId: "/tmp/one.jsonl",
      log: "[1/6] Explore started\n[6/6] [bash] npm test",
      actions: [],
    });
  });

  test("keeps dirty trailing state available for final detail and cancels it on cleanup", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });

    tracker.handleLifecycle({
      id: "Explore",
      agent: "task",
      description: "Inspect files",
      status: "started",
      parentToolCallId: "task-1",
      index: 0,
    });
    scheduler.advance(100);
    tracker.handleProgress({
      index: 0,
      agent: "task",
      task: "Inspect files",
      parentToolCallId: "task-1",
      progress: {
        id: "Explore",
        status: "running",
        recentOutput: ["found target file"],
      },
    });

    expect(emitted).toEqual(["task-1"]);
    expect(
      tracker.detailFor("task-1", {
        type: "sub_agent",
        log: "",
      }).log,
    ).toBe("Explore started\nfound target file");

    tracker.delete("task-1");
    scheduler.advance(500);

    expect(emitted).toEqual(["task-1"]);
    expect(
      tracker.detailFor("task-1", {
        type: "sub_agent",
        log: "static",
      }).log,
    ).toBe("static");
  });
});
