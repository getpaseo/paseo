import { describe, expect, it } from "vitest";
import { buildAgentFactsLine, type AgentFactsInput } from "./agent-facts-line";

const models = [
  {
    provider: "claude",
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    thinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
];

const modes = [
  { id: "default", label: "Default" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

const base: AgentFactsInput = {
  models,
  runtimeModelId: "claude-fable-5-1",
  configuredModelId: null,
  runtimeThinkingOptionId: "high",
  explicitThinkingOptionId: null,
  availableModes: modes,
  currentModeId: "bypassPermissions",
  contextWindowUsedTokens: 56_200,
  contextWindowMaxTokens: 200_000,
};

describe("buildAgentFactsLine", () => {
  it("joins model, thinking, mode, and context usage as the controls show them", () => {
    expect(buildAgentFactsLine(base)).toBe(
      "Fable 5.1 · High · Bypass permissions · 56k / 200k tokens (28%)",
    );
  });

  it("shows the raw model id before the catalog has loaded", () => {
    expect(
      buildAgentFactsLine({
        ...base,
        models: null,
        runtimeModelId: null,
        configuredModelId: "gpt-6.1-sol",
        runtimeThinkingOptionId: null,
        explicitThinkingOptionId: "medium",
        availableModes: [],
        contextWindowUsedTokens: null,
        contextWindowMaxTokens: null,
      }),
    ).toBe("gpt-6.1-sol · Medium");
  });

  it("falls back to the provider's first mode until the agent reports one", () => {
    expect(
      buildAgentFactsLine({
        ...base,
        currentModeId: null,
        contextWindowUsedTokens: undefined,
        contextWindowMaxTokens: undefined,
      }),
    ).toBe("Fable 5.1 · High · Default");
  });

  it("leaves thinking and context out when the agent has none", () => {
    expect(
      buildAgentFactsLine({
        ...base,
        models: [{ provider: "mock", id: "m", label: "Model M" }],
        runtimeModelId: "m",
        runtimeThinkingOptionId: null,
        availableModes: [],
        contextWindowUsedTokens: 10,
        contextWindowMaxTokens: 0,
      }),
    ).toBe("Model M");
  });

  it("is empty until the agent has a model", () => {
    expect(
      buildAgentFactsLine({ ...base, runtimeModelId: null, configuredModelId: " " }),
    ).toBeNull();
  });
});
