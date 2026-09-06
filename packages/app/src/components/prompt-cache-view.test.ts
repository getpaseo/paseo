import { describe, expect, it } from "vitest";
import type { AgentPromptCacheStatus } from "@getpaseo/protocol/agent-types";
import { derivePromptCacheView } from "./prompt-cache-view";

const OBSERVED_AT = "2026-09-03T12:00:00.000Z";
const OBSERVED_MS = Date.parse(OBSERVED_AT);

function status(overrides: Partial<AgentPromptCacheStatus> = {}): AgentPromptCacheStatus {
  return {
    observedAt: OBSERVED_AT,
    ttlSeconds: 300,
    lastRequest: { inputTokens: 800, cachedInputTokens: 12_300, cacheWriteTokens: 1100 },
    session: {
      inputTokens: 4000,
      cachedInputTokens: 40_000,
      cacheWriteTokens: 400,
      requestCount: 14,
    },
    ...overrides,
  };
}

describe("derivePromptCacheView", () => {
  it("reports warm while more than a minute of the TTL is left", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS + 60_000);
    expect({
      lifetime: view.lifetime,
      remainingSeconds: view.remainingSeconds,
      expiredForSeconds: view.expiredForSeconds,
      elapsedSeconds: view.elapsedSeconds,
    }).toEqual({
      lifetime: "warm",
      remainingSeconds: 240,
      expiredForSeconds: null,
      elapsedSeconds: 60,
    });
  });

  it("reports expiring for the last minute of the TTL, boundary included", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS + 240_000);
    expect({ lifetime: view.lifetime, remainingSeconds: view.remainingSeconds }).toEqual({
      lifetime: "expiring",
      remainingSeconds: 60,
    });
  });

  it("reports expired once the TTL has elapsed", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS + 540_000);
    expect({
      lifetime: view.lifetime,
      remainingSeconds: view.remainingSeconds,
      expiredForSeconds: view.expiredForSeconds,
      elapsedSeconds: view.elapsedSeconds,
    }).toEqual({
      lifetime: "expired",
      remainingSeconds: 0,
      expiredForSeconds: 240,
      elapsedSeconds: 540,
    });
  });

  it("reports expired the instant the TTL runs out", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS + 300_000);
    expect({ lifetime: view.lifetime, expiredForSeconds: view.expiredForSeconds }).toEqual({
      lifetime: "expired",
      expiredForSeconds: 0,
    });
  });

  it("reports an unknown lifetime when the provider documents no TTL", () => {
    const view = derivePromptCacheView(status({ ttlSeconds: undefined }), OBSERVED_MS + 120_000);
    expect({
      lifetime: view.lifetime,
      remainingSeconds: view.remainingSeconds,
      expiredForSeconds: view.expiredForSeconds,
      elapsedSeconds: view.elapsedSeconds,
    }).toEqual({
      lifetime: "unknown",
      remainingSeconds: null,
      expiredForSeconds: null,
      elapsedSeconds: 120,
    });
  });

  it("counts cache writes against the hit ratio", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS);
    expect(view.lastRequest).toEqual({
      // 12300 / (800 + 12300 + 1100)
      hitPercent: 87,
      cachedTokens: 12_300,
      freshTokens: 800,
      writtenTokens: 1100,
    });
    expect(view.session).toEqual({
      // 40000 / (4000 + 40000 + 400)
      hitPercent: 90,
      cachedTokens: 40_000,
      freshTokens: 4000,
      writtenTokens: 400,
      requestCount: 14,
    });
  });

  it("drops writes from the ratio when the provider omits them", () => {
    const view = derivePromptCacheView(
      status({
        lastRequest: { inputTokens: 800, cachedInputTokens: 12_300 },
      }),
      OBSERVED_MS,
    );
    expect(view.lastRequest).toEqual({
      // 12300 / (800 + 12300)
      hitPercent: 94,
      cachedTokens: 12_300,
      freshTokens: 800,
      writtenTokens: null,
    });
  });

  it("reports a zero hit ratio when no tokens were counted", () => {
    const view = derivePromptCacheView(
      status({
        lastRequest: { inputTokens: 0, cachedInputTokens: 0 },
        session: { inputTokens: 0, cachedInputTokens: 0, requestCount: 0 },
      }),
      OBSERVED_MS,
    );
    expect([view.lastRequest.hitPercent, view.session.hitPercent]).toEqual([0, 0]);
  });

  it("treats a request observed in the future as just observed", () => {
    const view = derivePromptCacheView(status(), OBSERVED_MS - 5000);
    expect({ elapsedSeconds: view.elapsedSeconds, lifetime: view.lifetime }).toEqual({
      elapsedSeconds: 0,
      lifetime: "warm",
    });
  });
});
