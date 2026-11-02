import { describe, expect, test } from "vitest";

import { OmpSubagentCardTracker } from "./subagent-card-tracker.js";
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

describe("OmpSubagentCardTracker", () => {
  test("keeps the card a launch marker while the child runs", () => {
    const emitted: string[] = [];
    const emit = (toolCallId: string) => {
      emitted.push(toolCallId);
      return true;
    };
    const tracker = new OmpSubagentCardTracker();
    tracker.handleLifecycle(LIFECYCLE, emit);
    for (const payload of PROGRESS) {
      tracker.handleProgress(payload, emit);
    }

    expect(emitted).toEqual([PARENT_TOOL_CALL_ID]);
    expect(
      tracker.detailFor(PARENT_TOOL_CALL_ID, {
        type: "sub_agent",
        subAgentType: "task",
        description: "Task arg description wins",
        log: "",
      }),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "task",
      description: "Task arg description wins",
      childSessionId: SESSION_FILE,
      log: "",
    });
  });

  test("re-emits the card when a later event names the child", () => {
    const emitted: string[] = [];
    const emit = (toolCallId: string) => {
      emitted.push(toolCallId);
      return true;
    };
    const tracker = new OmpSubagentCardTracker();
    tracker.handleLifecycle({ ...LIFECYCLE, description: undefined, sessionFile: undefined }, emit);
    tracker.handleProgress(PROGRESS[0], emit);

    expect(emitted).toEqual([PARENT_TOOL_CALL_ID, PARENT_TOOL_CALL_ID]);
    expect(tracker.detailFor(PARENT_TOOL_CALL_ID, { type: "sub_agent", log: "" })).toEqual({
      type: "sub_agent",
      childSessionId: SESSION_FILE,
      log: "",
    });

    tracker.delete(PARENT_TOOL_CALL_ID);
    expect(tracker.detailFor(PARENT_TOOL_CALL_ID, { type: "sub_agent", log: "" })).toEqual({
      type: "sub_agent",
      log: "",
    });
  });
  test("leaves the card alone when a later child of the same task starts", () => {
    const emitted: string[] = [];
    const emit = (toolCallId: string) => {
      emitted.push(toolCallId);
      return true;
    };
    const tracker = new OmpSubagentCardTracker();
    tracker.handleLifecycle(LIFECYCLE, emit);
    tracker.handleLifecycle(
      {
        ...LIFECYCLE,
        id: "Second",
        index: 1,
        description: "Second child",
        sessionFile: "/s.jsonl",
      },
      emit,
    );

    expect(emitted).toEqual([PARENT_TOOL_CALL_ID]);
    expect(tracker.detailFor(PARENT_TOOL_CALL_ID, { type: "sub_agent", log: "" })).toEqual({
      type: "sub_agent",
      description: "Run echo in subagent",
      childSessionId: SESSION_FILE,
      log: "",
    });
  });
});
