import { describe, expect, it } from "vitest";
import { resolveManualVoiceOrchestratorConfig } from "./config.js";

describe("manual voice orchestrator configuration", () => {
  it("uses every configured value exactly", () => {
    expect(
      resolveManualVoiceOrchestratorConfig({
        provider: "codex",
        model: "gpt-exact",
        modeId: "full-access",
        thinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-exact",
      modeId: "full-access",
      thinkingOptionId: "high",
    });
  });

  it.each([
    { provider: null, model: null, modeId: null, thinkingOptionId: null },
    { provider: "codex", model: "gpt-exact", modeId: null, thinkingOptionId: "high" },
    { provider: null, model: null, modeId: "full-access", thinkingOptionId: null },
  ])("rejects missing or partial required selection", (settings) => {
    expect(resolveManualVoiceOrchestratorConfig(settings)).toBeNull();
  });
});
