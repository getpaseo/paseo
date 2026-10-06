import { describe, expect, it } from "vitest";
import {
  getFeatureHighlightColor,
  getFeatureTooltip,
  getAgentControlHintKey,
  isFeatureActive,
  normalizeModelId,
  resolveAgentModelSelection,
} from "./utils";

describe("getAgentControlHintKey", () => {
  it("returns translation keys for each editable agent control hint", () => {
    expect(getAgentControlHintKey("thinking")).toBe("agentControls.hints.thinking");
    expect(getAgentControlHintKey("model")).toBe("agentControls.hints.model");
    expect(getAgentControlHintKey("mode")).toBe("agentControls.hints.mode");
  });
});

describe("feature metadata helpers", () => {
  it("prefers explicit feature tooltip copy", () => {
    expect(
      getFeatureTooltip({
        label: "Plan",
        tooltip: "Toggle plan mode",
      }),
    ).toBe("Toggle plan mode");
  });

  it("falls back to the feature label when no tooltip is provided", () => {
    expect(
      getFeatureTooltip({
        label: "Custom",
      }),
    ).toBe("Custom");
  });

  it("maps feature highlight colors by feature id", () => {
    expect(getFeatureHighlightColor("fast_mode")).toBe("yellow");
    expect(getFeatureHighlightColor("service_tier")).toBe("yellow");
    expect(getFeatureHighlightColor("plan_mode")).toBe("blue");
    expect(getFeatureHighlightColor("other")).toBe("default");
  });

  it("treats a select feature as active when a non-default option is selected", () => {
    const speed = {
      type: "select" as const,
      id: "service_tier",
      label: "Speed",
      options: [
        { id: "default", label: "Normal", isDefault: true },
        { id: "fast", label: "Fast" },
      ],
    };
    expect(isFeatureActive({ ...speed, value: "default" })).toBe(false);
    expect(isFeatureActive({ ...speed, value: "fast" })).toBe(true);
    expect(
      isFeatureActive({
        type: "toggle",
        id: "fast_mode",
        label: "Fast",
        value: true,
      }),
    ).toBe(true);
  });
});

describe("normalizeModelId", () => {
  it("treats empty values as unset", () => {
    expect(normalizeModelId("")).toBeNull();
    expect(normalizeModelId(undefined)).toBeNull();
  });

  it("returns trimmed model ids", () => {
    expect(normalizeModelId(" gpt-5.1-codex ")).toBe("gpt-5.1-codex");
    expect(normalizeModelId(" default ")).toBe("default");
  });
});

describe("resolveAgentModelSelection", () => {
  it("resolves a configured model alias to its canonical catalog model", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          provider: "claude",
          id: "claude-fable-5",
          aliases: ["claude-fable-5[1m]"],
          label: "Fable 5",
          thinkingOptions: [{ id: "high", label: "High" }],
          defaultThinkingOptionId: "high",
        },
      ],
      runtimeModelId: null,
      configuredModelId: "claude-fable-5[1m]",
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("claude-fable-5");
    expect(selection.displayModel).toBe("Fable 5");
    expect(selection.selectedThinkingId).toBe("high");
  });

  it("prefers runtime model over configured model", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [{ id: "low", label: "Low" }],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: "b",
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("a");
    expect(selection.displayModel).toBe("Model A");
    expect(selection.selectedThinkingId).toBe("low");
  });

  it("uses explicit thinking option when provided", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: "high",
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinking).toBe("High");
  });

  it("shows the thinking level the agent runs on when none was chosen", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "openrouter/google/gemini-3.6-flash",
          provider: "pi",
          label: "Gemini 3.6 Flash",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "medium",
        },
      ],
      runtimeModelId: "openrouter/google/gemini-3.6-flash",
      configuredModelId: null,
      runtimeThinkingOptionId: "high",
      explicitThinkingOptionId: null,
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinking).toBe("High");
  });

  it("falls back to the chosen thinking level when the runtime level is not a model option", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      runtimeThinkingOptionId: "xhigh",
      explicitThinkingOptionId: "high",
    });

    expect(selection.selectedThinkingId).toBe("high");
  });

  it("formats raw thinking labels in the selected model display", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "claude",
          label: "Model A",
          thinkingOptions: [
            { id: "none", label: "none" },
            { id: "xhigh", label: "xhigh" },
          ],
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: "xhigh",
    });

    expect(selection.selectedThinkingId).toBe("xhigh");
    expect(selection.displayThinking).toBe("Extra high");
  });

  it("falls back to the provider default model label instead of Auto", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          isDefault: true,
          thinkingOptions: [{ id: "low", label: "Low" }],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: null,
      configuredModelId: null,
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.displayModel).toBe("Model A");
    expect(selection.displayThinking).toBe("Low");
  });

  it("prefers the configured model when runtime model is not in the model list", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "default",
          provider: "claude",
          label: "Default (Sonnet 4.6)",
          isDefault: true,
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
          ],
        },
      ],
      runtimeModelId: "claude-sonnet-4-6-20260101",
      configuredModelId: "default",
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("default");
    expect(selection.displayModel).toBe("Default (Sonnet 4.6)");
    expect(selection.selectedThinkingId).toBe("low");
    expect(selection.displayThinking).toBe("Low");
  });

  it("shows the agent's own model when the catalog does not list it", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "gpt-6-sol",
          provider: "codex",
          label: "GPT-6-Sol",
          isDefault: true,
          thinkingOptions: [
            { id: "medium", label: "medium" },
            { id: "max", label: "max" },
          ],
          defaultThinkingOptionId: "medium",
        },
      ],
      runtimeModelId: "gpt-6.1-sol",
      configuredModelId: "gpt-6.1-sol",
      runtimeThinkingOptionId: null,
      explicitThinkingOptionId: "max",
    });

    expect(selection.selectedModel).toBeNull();
    expect(selection.activeModelId).toBe("gpt-6.1-sol");
    expect(selection.displayModel).toBe("gpt-6.1-sol");
    expect(selection.displayThinking).toBe("Max");
  });
});
