import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import { describe, expect, it } from "vitest";
import {
  createInTurnRetryPlan,
  inTurnFallbackExhaustedVisibility,
  inTurnFallbackVisibility,
  isQuotaOrRateLimitError,
  resolveFallbackModel,
  selectNextInTurnFallback,
} from "./in-turn-fallback.js";

const profile = (id: string, provider: string, model: string): AgentProfile => ({
  id,
  name: id,
  provider,
  model,
});

describe("in-turn quota fallback", () => {
  it("detects provider quota and rate-limit failures without matching ordinary errors", () => {
    expect(isQuotaOrRateLimitError({ code: "rate_limit_exceeded" })).toBe(true);
    expect(isQuotaOrRateLimitError({ status: 429, message: "Too many requests" })).toBe(true);
    expect(isQuotaOrRateLimitError({ code: "invalid_request", message: "bad prompt" })).toBe(false);
  });

  it("selects the next existing profile before switching provider", () => {
    const result = selectNextInTurnFallback({
      currentProfileId: "claude-work",
      currentProvider: "claude",
      profiles: [
        profile("claude-work", "claude", "claude-opus"),
        profile("claude-fast", "claude", "claude-sonnet"),
        profile("codex-work", "codex", "gpt-6-sol"),
      ],
    });
    expect(result?.profile.id).toBe("claude-fast");
  });

  it("falls back from Opus or Sonnet to an available Sol-class model", () => {
    expect(
      resolveFallbackModel({
        currentModel: "claude-opus-5-5",
        requestedModel: "claude-opus-5-5",
        availableModels: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna-max" }],
      }),
    ).toBe("gpt-6-sol");
  });

  it("keeps the original prompt and canonical history in the retry plan", () => {
    const candidate = {
      profile: profile("codex-work", "codex", "gpt-6-sol"),
      model: "gpt-6-sol",
      reason: "next-profile" as const,
    };
    const history = [{ type: "user_message" as const, text: "Keep going" }];
    const plan = createInTurnRetryPlan({ prompt: "Fix the failing test", history, candidate });
    expect(plan.prompt).toBe("Fix the failing test");
    expect(plan.context.history).toBe(history);
  });

  it("reports exhaustion and every switch in visible timeline items", () => {
    const exhausted = inTurnFallbackExhaustedVisibility();
    expect(exhausted).toMatchObject({ type: "notification", level: "error" });

    const candidate = {
      profile: profile("codex-work", "codex", "gpt-6-sol"),
      model: "gpt-6-sol",
      reason: "next-profile" as const,
    };
    expect(
      inTurnFallbackVisibility({ provider: "claude", model: "claude-sonnet" }, candidate)[0],
    ).toMatchObject({
      type: "notification",
      level: "warning",
    });
  });
});
