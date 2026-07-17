import { describe, expect, test } from "vitest";

import { mapOmpUsage } from "./usage-mapper.js";

describe("OMP usage mapper", () => {
  test("adds OMP context usage to token and cost totals", () => {
    const usage = mapOmpUsage({
      stats: {
        tokens: { input: 28237, output: 548, cacheRead: 269824, cacheWrite: 0, total: 298609 },
        cost: 0.29253700000000005,
      },
      state: {
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionId: "session",
        messageCount: 0,
        queuedMessageCount: 0,
        contextUsage: { tokens: 23656, contextWindow: 272000, percent: 8.7 },
      },
      baseUsage: {
        inputTokens: 28237,
        cachedInputTokens: 269824,
        outputTokens: 548,
        totalCostUsd: 0.29253700000000005,
      },
    });

    expect(usage).toEqual({
      inputTokens: 28237,
      cachedInputTokens: 269824,
      outputTokens: 548,
      totalCostUsd: 0.29253700000000005,
      contextWindowMaxTokens: 272000,
      contextWindowUsedTokens: 23656,
    });
  });
});
