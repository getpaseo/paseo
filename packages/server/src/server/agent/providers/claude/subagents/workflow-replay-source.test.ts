import { describe, expect, it } from "vitest";

import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import { foldSubagentObservations } from "./observation.js";
import {
  observeReplayWorkflows,
  parseClaudeWorkflowRun,
  type ClaudeWorkflowParentEntry,
} from "./workflow-replay-source.js";

const TOOL_CALL_ID = "toolu_01XskpjeASyuFyXC5qsLHYps";
const RUN_ID = "wf_4a0af4f7-f56";

function parentEntries(): ClaudeWorkflowParentEntry[] {
  return [
    {
      message: {
        content: [{ type: "tool_use", id: TOOL_CALL_ID, name: "Workflow", input: {} }],
      },
    },
    {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_CALL_ID,
            content: `Workflow launched in background.\nRun ID: ${RUN_ID}`,
          },
        ],
      },
    },
  ];
}

describe("Claude workflow replay", () => {
  it("parses the persisted run summary observed from Claude Code 2.1.220", () => {
    expect(
      parseClaudeWorkflowRun(
        JSON.stringify({
          runId: RUN_ID,
          timestamp: "2026-08-06T08:04:46.347Z",
          summary: "Runs one deterministic child and returns its structured result",
          workflowName: "paseo-workflow-one-child",
          status: "completed",
          startTime: 1786003484150,
          defaultModel: "claude-sonnet-5",
          totalTokens: 20_417,
          workflowProgress: [{ type: "workflow_phase", title: "Inspect" }],
        }),
      ),
    ).toEqual({
      runId: RUN_ID,
      timestamp: "2026-08-06T08:04:46.347Z",
      summary: "Runs one deterministic child and returns its structured result",
      workflowName: "paseo-workflow-one-child",
      status: "completed",
      startTime: 1786003484150,
      defaultModel: "claude-sonnet-5",
      totalTokens: 20_417,
    });
  });

  it("rebuilds the same generic completed descriptor through the parent Workflow call", () => {
    const observations = observeReplayWorkflows({
      workflows: [
        {
          runId: RUN_ID,
          summary: "Runs one deterministic child and returns its structured result",
          status: "completed",
          startTime: 1786003484150,
          defaultModel: "claude-sonnet-5",
          totalTokens: 20_417,
        },
      ],
      parentEntries: parentEntries(),
    });
    const store = new ProviderSubagentStore();
    for (const event of foldSubagentObservations(observations)) {
      store.apply("parent", "claude", event);
    }

    expect(store.get("parent", TOOL_CALL_ID)).toMatchObject({
      id: TOOL_CALL_ID,
      title: "Workflow",
      description: "Runs one deterministic child and returns its structured result",
      subtitle: "Workflow · Sonnet 5 · 20.4k tokens",
      status: "completed",
      toolCallId: TOOL_CALL_ID,
    });
  });

  it("fails a nonterminal persisted run because its former runtime cannot update it", () => {
    const observations = observeReplayWorkflows({
      workflows: [{ runId: RUN_ID, summary: "Interrupted workflow", status: "running" }],
      parentEntries: parentEntries(),
    });

    expect(observations.at(-1)).toMatchObject({
      kind: "status",
      id: TOOL_CALL_ID,
      status: "failed",
    });
  });

  it("drops a run that no parent Workflow tool call declared", () => {
    expect(
      observeReplayWorkflows({
        workflows: [{ runId: RUN_ID, status: "completed" }],
        parentEntries: [],
      }),
    ).toEqual([]);
  });

  it.each(["", "not json", "[]", '{"status":"completed"}'])(
    "ignores malformed persisted content %j",
    (contents) => {
      expect(parseClaudeWorkflowRun(contents)).toBeNull();
    },
  );
});
