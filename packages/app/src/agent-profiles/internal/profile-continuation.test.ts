import { describe, expect, it } from "vitest";
import type { MaterializedAgentProfile } from "./materialize-profile";
import { requiresProfileContinuation } from "./profile-continuation";

function profile(overrides: Partial<MaterializedAgentProfile> = {}): MaterializedAgentProfile {
  return {
    provider: "codex",
    accountProfileId: undefined,
    modelId: "gpt-5.4",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: {},
    ...overrides,
  };
}

const target = {
  kind: "agent" as const,
  agentId: "agent-1",
  provider: "codex",
  accountProfileId: "pac_0123456789abcdef",
  availableModeIds: ["full-access"],
};

describe("requiresProfileContinuation", () => {
  it("keeps same-process profile changes in place", () => {
    expect(requiresProfileContinuation(profile(), target)).toBe(false);
  });

  it("continues in a linked draft for provider or explicit account changes", () => {
    expect(requiresProfileContinuation(profile({ provider: "claude" }), target)).toBe(true);
    expect(
      requiresProfileContinuation(profile({ accountProfileId: "pac_fedcba9876543210" }), target),
    ).toBe(true);
    expect(requiresProfileContinuation(profile({ accountProfileId: null }), target)).toBe(true);
  });
});
