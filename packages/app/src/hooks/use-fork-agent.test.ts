import { describe, expect, it } from "vitest";
import { buildForkDraftSetup, type ForkAgentSetupSource } from "./fork-agent-setup";

function source(): ForkAgentSetupSource {
  return {
    provider: "codex",
    accountProfileId: "pac_0123456789abcdef",
    cwd: "/repo",
    currentModeId: "full-access",
    model: "gpt-5.4",
    thinkingOptionId: "high",
    runtimeInfo: null,
    features: [{ id: "fast_mode", label: "Fast", type: "toggle", value: true }],
  };
}

describe("buildForkDraftSetup", () => {
  it("preserves the original provider account for an ordinary fork", () => {
    expect(buildForkDraftSetup(source())).toMatchObject({
      provider: "codex",
      accountProfileId: "pac_0123456789abcdef",
      model: "gpt-5.4",
      featureValues: { fast_mode: true },
    });
  });

  it("creates a clean linked continuation when provider and account are overridden", () => {
    expect(
      buildForkDraftSetup(source(), {
        provider: "claude",
        accountProfileId: null,
        model: "claude-opus-4",
        modeId: null,
        thinkingOptionId: null,
      }),
    ).toMatchObject({
      provider: "claude",
      accountProfileId: null,
      model: "claude-opus-4",
      modeId: null,
      thinkingOptionId: null,
      cwd: "/repo",
    });
  });
});
