import { describe, expect, test } from "vitest";

import {
  type CodexAccountRateLimits,
  isCodexUsageLimitError,
  lunaReserveCovers,
  ordinaryUsageRecovered,
  parseCodexAccountRateLimits,
} from "./luna-reserve.js";

// The shape `account/rateLimits/read` returns once ordinary usage is used up and the
// account has Luna Reserve, as reported in openai/codex#45132.
function reserveOffered(overrides: Record<string, unknown> = {}): CodexAccountRateLimits {
  const limits = parseCodexAccountRateLimits({
    accountId: "account-a",
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: "codex", primary: { usedPercent: 100 } },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", limitName: null, normalModelSlug: null },
      base_model_inference: {
        limitId: "base_model_inference",
        limitName: "gpt-reserve",
        normalModelSlug: "gpt-5.6-luna",
        primary: { usedPercent: 6, windowDurationMins: 10080 },
      },
    },
    rateLimitUpsell: { banner_type: "luna_reserve", title: "Luna Reserve", ctas: [] },
    ...overrides,
  });
  if (!limits) throw new Error("fixture did not parse");
  return limits;
}

function ordinaryAllowed(overrides: Record<string, unknown> = {}): CodexAccountRateLimits {
  const limits = parseCodexAccountRateLimits({
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: "codex", primary: { usedPercent: 2 } },
    rateLimitsByLimitId: null,
    rateLimitUpsell: null,
    ...overrides,
  });
  if (!limits) throw new Error("fixture did not parse");
  return limits;
}

describe("lunaReserveCovers", () => {
  test("covers the model the reserve quota is named after", () => {
    expect(lunaReserveCovers("gpt-5.6-luna", reserveOffered())).toBe(true);
  });

  test("never covers another model", () => {
    expect(lunaReserveCovers("gpt-5.6-sol", reserveOffered())).toBe(false);
  });

  test("needs the backend to say ordinary usage is blocked", () => {
    expect(lunaReserveCovers("gpt-5.6-luna", reserveOffered({ ordinaryUsageAllowed: true }))).toBe(
      false,
    );
    expect(lunaReserveCovers("gpt-5.6-luna", reserveOffered({ ordinaryUsageAllowed: null }))).toBe(
      false,
    );
  });

  test("needs the Luna Reserve offer", () => {
    expect(lunaReserveCovers("gpt-5.6-luna", reserveOffered({ rateLimitUpsell: null }))).toBe(
      false,
    );
    expect(
      lunaReserveCovers(
        "gpt-5.6-luna",
        reserveOffered({ rateLimitUpsell: { banner_type: "add_credits" } }),
      ),
    ).toBe(false);
  });

  test("respects an offer made for a different blocked model", () => {
    const offer = (blocked: string) =>
      reserveOffered({
        rateLimitUpsell: { banner_type: "luna_reserve", blocked_model_slug: blocked },
      });
    expect(lunaReserveCovers("gpt-5.6-luna", offer("gpt-5.6-terra"))).toBe(false);
    expect(lunaReserveCovers("gpt-5.6-luna", offer("gpt-5.6-luna"))).toBe(true);
  });

  test("needs a reserve quota", () => {
    expect(lunaReserveCovers("gpt-5.6-luna", reserveOffered({ rateLimitsByLimitId: {} }))).toBe(
      false,
    );
  });

  test("falls back to the Luna model name when the quota does not name its model", () => {
    const unnamed = reserveOffered({
      rateLimitsByLimitId: {
        base_model_inference: { limitId: "base_model_inference", limitName: "gpt-reserve" },
      },
    });
    expect(lunaReserveCovers("gpt-5.6-luna", unnamed)).toBe(true);
    expect(lunaReserveCovers("gpt-5.6-sol", unnamed)).toBe(false);
  });
});

describe("ordinaryUsageRecovered", () => {
  test("recovers on the backend's explicit permission", () => {
    expect(ordinaryUsageRecovered(ordinaryAllowed())).toBe(true);
  });

  test("recovers on usable credits", () => {
    expect(
      ordinaryUsageRecovered(
        ordinaryAllowed({
          ordinaryUsageAllowed: false,
          rateLimits: { credits: { hasCredits: true, unlimited: false } },
        }),
      ),
    ).toBe(true);
  });

  test("does not recover while anything still blocks", () => {
    expect(ordinaryUsageRecovered(reserveOffered())).toBe(false);
    expect(ordinaryUsageRecovered(ordinaryAllowed({ ordinaryUsageAllowed: null }))).toBe(false);
    expect(
      ordinaryUsageRecovered(ordinaryAllowed({ rateLimitUpsell: { banner_type: "luna_reserve" } })),
    ).toBe(false);
    expect(
      ordinaryUsageRecovered(ordinaryAllowed({ rateLimits: { spendControlReached: true } })),
    ).toBe(false);
    expect(
      ordinaryUsageRecovered(
        ordinaryAllowed({ rateLimits: { rateLimitReachedType: "rate_limit_reached" } }),
      ),
    ).toBe(false);
  });
});

test("recognizes the usage-limit error code", () => {
  expect(isCodexUsageLimitError("usageLimitExceeded")).toBe(true);
  expect(isCodexUsageLimitError("rateLimitExceeded")).toBe(false);
  expect(isCodexUsageLimitError(null)).toBe(false);
});
