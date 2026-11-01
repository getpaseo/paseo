import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import type { UsageTotals } from "@getpaseo/protocol/goal/types";
import { en } from "@/i18n/resources/en";
import {
  agentUsageLines,
  amountLabel,
  compactAmountLabel,
  costAmount,
  formatTokenCount,
  coverageLabel,
  goalUsageBudgets,
  roleUsageLines,
  tokenAmount,
  tokenSplitLabel,
  usageBudgetLabel,
} from "./goal-usage";
import { formatUsd } from "./goal-progress";
import { makeGoal, makeTask } from "./test-utils/goal-fixture";

let t: TFunction;

beforeAll(async () => {
  t = await createInstance().init({
    lng: "en",
    compatibilityJSON: "v4",
    interpolation: { escapeValue: false },
    resources: { en: { translation: en } },
  });
});

// Four turns, every one with tokens, one with a cost: a Claude Lead and Codex workers.
const MIXED: UsageTotals = {
  inputTokens: 120_000,
  cachedInputTokens: 1_200_000,
  outputTokens: 69_700,
  totalTokens: 189_700,
  costUsd: 0.53,
  reportedTurns: 4,
  totalTurns: 4,
  costReportedTurns: 1,
  tokenReportedTurns: 4,
};

describe("tokenAmount and costAmount", () => {
  it("is not reported without usage or when no turn reported it", () => {
    expect(tokenAmount(undefined)).toEqual({ kind: "not_reported" });
    expect(costAmount({ ...MIXED, costReportedTurns: 0, costUsd: 0 })).toEqual({
      kind: "not_reported",
    });
    expect(tokenAmount({ ...MIXED, tokenReportedTurns: 0 })).toEqual({ kind: "not_reported" });
  });

  it("is a lower bound when only some turns reported it", () => {
    expect(costAmount(MIXED)).toEqual({ kind: "at_least", value: 0.53, reported: 1, total: 4 });
    expect(tokenAmount(MIXED)).toEqual({ kind: "exact", value: 189_700 });
    expect(tokenAmount({ ...MIXED, tokenReportedTurns: 3 })).toMatchObject({ kind: "at_least" });
  });

  it("follows the CLI rule for hosts that do not count cost reports", () => {
    const legacy: UsageTotals = { ...MIXED, reportedTurns: 3 };
    delete legacy.costReportedTurns;
    delete legacy.tokenReportedTurns;
    expect(costAmount(legacy)).toEqual({ kind: "exact", value: 0.53 });
    expect(costAmount({ ...legacy, costUsd: 0 })).toEqual({ kind: "untracked" });
    // Tokens fall back to the turns that reported any usage.
    expect(tokenAmount(legacy)).toMatchObject({ kind: "at_least", reported: 3, total: 4 });
  });
});

describe("formatTokenCount", () => {
  it("keeps one decimal at every size, as the CLI does", () => {
    expect(formatTokenCount(189_700)).toBe("189.7k");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(800)).toBe("800");
  });
});

describe("usage labels", () => {
  it("marks a lower bound in full and compact form", () => {
    const cost = costAmount(MIXED);
    expect(amountLabel(t, cost, formatUsd)).toBe("At least $0.53");
    expect(compactAmountLabel(t, cost, formatUsd)).toBe("≥$0.53");
    expect(coverageLabel(t, cost, "cost")).toBe("Cost reported for 1 of 4 turns");
    expect(coverageLabel(t, tokenAmount(MIXED), "tokens")).toBeNull();
    expect(amountLabel(t, { kind: "not_reported" }, formatUsd)).toBe("Not reported");
    expect(compactAmountLabel(t, { kind: "untracked" }, formatUsd)).toBe("not reported");
  });

  it("splits tokens into input, cache reads and output", () => {
    expect(tokenSplitLabel(t, MIXED)).toBe("In 120k · Cached 1.2M · Out 69.7k");
    expect(tokenSplitLabel(t, { ...MIXED, tokenReportedTurns: 0 })).toBeNull();
  });

  it("measures usage against the goal's caps", () => {
    const goal = makeGoal({
      usage: MIXED,
      config: { ...makeGoal().config!, limits: { maxTotalTokens: 1_000_000, maxCostUsd: 5 } },
    });
    const { tokens, cost } = goalUsageBudgets(goal);
    expect(tokens.budget).toMatchObject({ kind: "limited", fraction: 0.1897 });
    expect(usageBudgetLabel(t, tokens, formatTokenCount)).toBe("189.7k of 1M");
    expect(usageBudgetLabel(t, cost, formatUsd)).toBe("At least $0.53 of $5.00");
    expect(usageBudgetLabel(t, goalUsageBudgets(makeGoal()).cost, formatUsd)).toBe("Not reported");
  });
});

describe("role and agent lines", () => {
  const codexWorker: UsageTotals = {
    ...MIXED,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 500,
    totalTokens: 1500,
    costUsd: 0,
    reportedTurns: 2,
    totalTurns: 2,
    costReportedTurns: 0,
    tokenReportedTurns: 2,
  };

  it("lists roles that recorded a turn, Lead first", () => {
    const lines = roleUsageLines(t, {
      usageByRole: { worker: codexWorker, lead: { ...MIXED, totalTurns: 1, costReportedTurns: 1 } },
    });
    expect(lines.map((line) => [line.title, line.total, line.cost])).toEqual([
      ["Lead", "189.7k", "$0.53"],
      ["Workers", "1.5k", "not reported"],
    ]);
    expect(roleUsageLines(t, {})).toEqual([]);
  });

  it("names each agent's work, most recent first, with its provider and thinking", () => {
    const goal = makeGoal({
      tasks: [makeTask("t1", { title: "Add login" })],
      usageBreakdown: [
        {
          agentId: "lead-1",
          role: "lead",
          provider: "claude",
          model: "opus",
          thinking: "high",
          usage: MIXED,
          firstAt: "2026-10-21T00:00:00.000Z",
          lastAt: "2026-10-21T00:01:00.000Z",
        },
        {
          agentId: "worker-1",
          role: "worker",
          taskId: "t1",
          runId: "r1",
          provider: "codex",
          usage: codexWorker,
          firstAt: "2026-10-21T00:02:00.000Z",
          lastAt: "2026-10-21T00:03:00.000Z",
        },
        {
          agentId: "reviewer-1",
          role: "reviewer",
          changeSetId: "cs-9",
          usage: { ...codexWorker, reportedTurns: 0, tokenReportedTurns: 0 },
          firstAt: "2026-10-21T00:04:00.000Z",
          lastAt: "2026-10-21T00:05:00.000Z",
        },
      ],
    });
    const lines = agentUsageLines(t, goal, (id) => id.toUpperCase());
    expect(lines.map((line) => line.key)).toEqual(["reviewer-1", "worker-1", "lead-1"]);
    expect(lines[0]).toMatchObject({
      title: "Reviewer · cs-9",
      detail: null,
      input: "-",
      total: "not reported",
      cost: "not reported",
    });
    expect(lines[1]).toMatchObject({
      title: "Worker · Add login",
      detail: "codex",
      turns: "2",
      input: "1k",
      output: "500",
      total: "1.5k",
      coverage: null,
    });
    expect(lines[2]).toMatchObject({
      title: "Lead",
      detail: "claude/opus · Thinking HIGH",
      cost: "≥$0.53",
      coverage: "Cost reported for 1 of 4 turns",
    });
  });
});
