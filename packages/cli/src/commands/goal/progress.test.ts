import { describe, expect, test } from "vitest";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { formatDuration, formatUsage, goalElapsedMs, taskTimes, taskUsage } from "./progress.js";
import { toGoalRow } from "./shared.js";
import { goalUsageRows } from "./usage.js";

const usage = (
  totalTokens: number,
  costUsd: number,
  reportedTurns: number,
  totalTurns: number,
) => ({
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens,
  costUsd,
  reportedTurns,
  totalTurns,
});

const goal: Goal = {
  id: "g1",
  title: "Ship",
  objective: "",
  status: "executing",
  config: null,
  leadAgentId: null,
  leadWorkspaceId: null,
  criteria: [{ id: "c1", text: "works", verifiedAt: null, evidence: null }],
  tasks: [
    {
      id: "a",
      title: "A",
      description: "",
      kind: "implement",
      dependsOn: [],
      status: "succeeded",
      attempts: 2,
      error: null,
      summary: null,
    },
  ],
  runs: [
    {
      id: "a-a1",
      taskId: "a",
      provider: "codex",
      agentId: "x",
      workspaceId: null,
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      error: "boom",
      usage: usage(1000, 0.1, 1, 1),
    },
    {
      id: "a-a2",
      taskId: "a",
      provider: "codex",
      agentId: "y",
      workspaceId: null,
      status: "succeeded",
      startedAt: "2026-01-01T00:02:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      error: null,
      usage: usage(0, 0, 0, 1),
    },
  ],
  changeSets: [],
  integration: null,
  usage: usage(12_345, 0.42, 3, 5),
  lastSeq: 9,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
};

describe("goal progress formatting", () => {
  test("durations and usage read plainly", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatUsage(undefined)).toBe("-");
    expect(formatUsage(usage(0, 0, 0, 4))).toBe("not reported (0/4 turns)");
    expect(formatUsage(goal.usage)).toBe("12.3k tok $0.42 (3/5 turns)");
  });

  test("task times and usage come from the task's runs", () => {
    const task = goal.tasks[0];
    if (!task) throw new Error("no task");
    expect(taskTimes(goal, task)).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(taskUsage(goal, task)).toMatchObject({
      totalTokens: 1000,
      reportedTurns: 1,
      totalTurns: 2,
    });
  });

  test("a live goal's elapsed time runs to now; the row shows pause, usage and what it waits on", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    expect(goalElapsedMs(goal, now)).toBe(600_000);
    expect(goalElapsedMs({ ...goal, status: "completed" }, now)).toBe(300_000);
    const row = toGoalRow({ ...goal, pausedAt: "2026-01-01T00:06:00.000Z" }, now);
    expect(row).toMatchObject({
      status: "executing (paused)",
      tasks: "1/1",
      elapsed: "10m 00s",
      usage: "12.3k tok $0.42 (3/5 turns)",
      waitingOn: "resume (paused)",
    });
  });

  test("an acknowledged ended goal says so in its status", () => {
    const row = toGoalRow({
      ...goal,
      status: "failed",
      acknowledgedAt: "2026-01-01T00:07:00.000Z",
    });
    expect(row.status).toBe("failed (acknowledged)");
    expect(row.waitingOn).toBe("-");
  });

  test("a cost reported for only some turns is shown as a lower bound", () => {
    const counted = (costReportedTurns: number, totalTurns: number) => ({
      ...usage(189_733, 0.53, totalTurns, totalTurns),
      costReportedTurns,
      tokenReportedTurns: totalTurns,
    });
    expect(formatUsage(counted(4, 4))).toBe("189.7k tok $0.53 (4/4 turns)");
    expect(formatUsage(counted(1, 4))).toBe("189.7k tok >=$0.53 (4/4 turns)");
    expect(formatUsage({ ...counted(0, 4), costUsd: 0 })).toBe("189.7k tok no cost (4/4 turns)");
  });
});

describe("goal usage per agent", () => {
  const totals = (
    input: number,
    cached: number,
    output: number,
    cost: number,
    costTurns: number,
  ) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: input + output,
    costUsd: cost,
    reportedTurns: 1,
    totalTurns: 1,
    costReportedTurns: costTurns,
    tokenReportedTurns: 1,
  });
  const lead = totals(8, 174_852, 7_609, 0.53, 1);
  const worker = totals(573, 178_560, 2_983, 0, 0);
  const all = {
    ...totals(581, 353_412, 10_592, 0.53, 1),
    reportedTurns: 2,
    totalTurns: 2,
    tokenReportedTurns: 2,
  };

  test("lists each agent, then each role and the goal's total, marking cost not reported", () => {
    const rows = goalUsageRows({
      ...goal,
      usage: all,
      usageByRole: { lead, worker },
      usageBreakdown: [
        {
          agentId: "41692d3c-1282-4931-bc02-1ee3d8e0a0b6",
          role: "lead",
          provider: "claude",
          model: "claude-opus-5-5",
          thinking: "medium",
          usage: lead,
          firstAt: "2026-01-01T00:00:00.000Z",
          lastAt: "2026-01-01T00:00:00.000Z",
        },
        {
          agentId: "d50dc5af-93ed-47c7-898f-bcf52e56bee5",
          role: "worker",
          taskId: "t2",
          runId: "t2-a1",
          provider: "codex",
          usage: worker,
          firstAt: "2026-01-01T00:00:00.000Z",
          lastAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      usageBreakdownTruncated: 3,
    });
    expect(rows).toEqual([
      {
        agent: "41692d3c",
        role: "lead",
        work: "-",
        provider: "claude/claude-opus-5-5",
        thinking: "medium",
        turns: "1/1",
        input: "8",
        cached: "174.9k",
        output: "7.6k",
        total: "7.6k",
        cost: "$0.53",
      },
      expect.objectContaining({
        agent: "d50dc5af",
        work: "t2/t2-a1",
        provider: "codex",
        thinking: "-",
        cost: "not reported",
      }),
      expect.objectContaining({ agent: "...", work: "3 older agents not listed" }),
      expect.objectContaining({ agent: "ROLE", role: "lead", cost: "$0.53" }),
      expect.objectContaining({ agent: "ROLE", role: "worker", cost: "not reported" }),
      expect.objectContaining({
        agent: "TOTAL",
        role: "all",
        turns: "2/2",
        total: "11.2k",
        cost: ">=$0.53 (1/2)",
      }),
    ]);
  });

  test("a host without the breakdown is told apart from a goal with no usage", () => {
    expect(goalUsageRows({ ...goal, usage: undefined })).toEqual([]);
    expect(goalUsageRows(goal)).toBeNull();
  });
});
