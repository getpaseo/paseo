import { describe, expect, it } from "vitest";
import { applyPromptCacheSample } from "./prompt-cache-status.js";

const t0 = new Date("2026-09-03T10:00:00.000Z");
const t1 = new Date("2026-09-03T10:00:30.000Z");
const t2 = new Date("2026-09-03T10:01:00.000Z");

describe("applyPromptCacheSample", () => {
  it("accumulates per-request samples into session totals", () => {
    const first = applyPromptCacheSample(
      undefined,
      {
        kind: "request",
        inputTokens: 1200,
        cachedInputTokens: 0,
        cacheWriteTokens: 1100,
        ttlSeconds: 300,
      },
      t0,
    );
    expect(first).toEqual({
      observedAt: t0.toISOString(),
      ttlSeconds: 300,
      lastRequest: { inputTokens: 1200, cachedInputTokens: 0, cacheWriteTokens: 1100 },
      session: { inputTokens: 1200, cachedInputTokens: 0, cacheWriteTokens: 1100, requestCount: 1 },
    });

    const second = applyPromptCacheSample(
      first,
      {
        kind: "request",
        inputTokens: 40,
        cachedInputTokens: 2300,
        cacheWriteTokens: 0,
        ttlSeconds: 300,
      },
      t1,
    );
    expect(second).toEqual({
      observedAt: t1.toISOString(),
      ttlSeconds: 300,
      lastRequest: { inputTokens: 40, cachedInputTokens: 2300, cacheWriteTokens: 0 },
      session: {
        inputTokens: 1240,
        cachedInputTokens: 2300,
        cacheWriteTokens: 1100,
        requestCount: 2,
      },
    });
  });

  it("ignores an empty request sample", () => {
    expect(
      applyPromptCacheSample(
        undefined,
        { kind: "request", inputTokens: 0, cachedInputTokens: 0 },
        t0,
      ),
    ).toBeUndefined();
  });

  it("derives the last request from cumulative deltas", () => {
    const first = applyPromptCacheSample(
      undefined,
      { kind: "cumulative", inputTokens: 500, cachedInputTokens: 8000 },
      t0,
    );
    expect(first).toEqual({
      observedAt: t0.toISOString(),
      lastRequest: { inputTokens: 500, cachedInputTokens: 8000 },
      session: { inputTokens: 500, cachedInputTokens: 8000, requestCount: 1 },
    });

    const unchanged = applyPromptCacheSample(
      first,
      { kind: "cumulative", inputTokens: 500, cachedInputTokens: 8000 },
      t1,
    );
    expect(unchanged).toBe(first);

    const second = applyPromptCacheSample(
      first,
      { kind: "cumulative", inputTokens: 620, cachedInputTokens: 17000, cacheWriteTokens: 90 },
      t2,
    );
    expect(second).toEqual({
      observedAt: t2.toISOString(),
      lastRequest: { inputTokens: 120, cachedInputTokens: 9000, cacheWriteTokens: 90 },
      session: {
        inputTokens: 620,
        cachedInputTokens: 17000,
        cacheWriteTokens: 90,
        requestCount: 2,
      },
    });
  });

  it("restarts the session when cumulative totals go backwards", () => {
    const first = applyPromptCacheSample(
      undefined,
      { kind: "cumulative", inputTokens: 5000, cachedInputTokens: 90000 },
      t0,
    );
    const reset = applyPromptCacheSample(
      first,
      { kind: "cumulative", inputTokens: 300, cachedInputTokens: 1000 },
      t1,
    );
    expect(reset).toEqual({
      observedAt: t1.toISOString(),
      lastRequest: { inputTokens: 300, cachedInputTokens: 1000 },
      session: { inputTokens: 300, cachedInputTokens: 1000, requestCount: 1 },
    });
  });
});
