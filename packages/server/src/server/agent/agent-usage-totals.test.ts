import { describe, expect, test } from "vitest";
import { addTurnUsage } from "./agent-usage-totals.js";

describe("addTurnUsage", () => {
  test("sums per-turn tokens", () => {
    const one = addTurnUsage(undefined, {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
    });
    const two = addTurnUsage(one, { inputTokens: 50, outputTokens: 5 });
    expect(two).toMatchObject({
      turns: 2,
      inputTokens: 150,
      cachedInputTokens: 40,
      outputTokens: 15,
    });
  });

  test("turns a running cost total into deltas and survives a provider restart", () => {
    let totals = addTurnUsage(undefined, { totalCostUsd: 0.2 });
    totals = addTurnUsage(totals, { totalCostUsd: 0.5 });
    expect(totals.totalCostUsd).toBeCloseTo(0.5);
    totals = addTurnUsage(totals, { totalCostUsd: 0.1 });
    expect(totals.totalCostUsd).toBeCloseTo(0.6);
  });

  test("keeps the cost baseline when a turn reports no cost", () => {
    let totals = addTurnUsage(undefined, { totalCostUsd: 0.3 });
    totals = addTurnUsage(totals, { outputTokens: 1 });
    totals = addTurnUsage(totals, { totalCostUsd: 0.4 });
    expect(totals.totalCostUsd).toBeCloseTo(0.4);
  });
});
