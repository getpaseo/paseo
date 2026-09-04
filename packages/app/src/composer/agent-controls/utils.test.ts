import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  formatAgentModelDisplayMeta,
  getFeatureHighlightColor,
  getFeatureTooltip,
  getAgentControlHintKey,
  normalizeModelId,
  resolveAgentModelDisplay,
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
    expect(getFeatureHighlightColor("plan_mode")).toBe("blue");
    expect(getFeatureHighlightColor("other")).toBe("default");
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

describe("formatAgentModeLabel", () => {
  it("sentence-cases provider mode labels", () => {
    expect(formatAgentModeLabel({ id: "plan", label: "Plan" })).toBe("Plan");
    expect(formatAgentModeLabel({ id: "full-access", label: "Full Access" })).toBe("Full access");
    expect(formatAgentModeLabel({ id: "auto-review", label: "Auto-review" })).toBe("Auto-review");
    expect(formatAgentModeLabel({ id: "read_only", label: "read_only" })).toBe("Read only");
    expect(formatAgentModeLabel({ id: "acceptEdits", label: "acceptEdits" })).toBe("Accept edits");
  });

  it("splits compact mode ids when no provider label is available", () => {
    expect(formatAgentModeLabel({ id: "auto-review" })).toBe("Auto review");
  });
});

describe("formatThinkingOptionLabel", () => {
  it("formats compact thinking option labels for display", () => {
    expect(formatThinkingOptionLabel({ id: "none", label: "none" })).toBe("None");
    expect(formatThinkingOptionLabel({ id: "low", label: "low" })).toBe("Low");
    expect(formatThinkingOptionLabel({ id: "medium", label: "medium" })).toBe("Medium");
    expect(formatThinkingOptionLabel({ id: "high", label: "high" })).toBe("High");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "xhigh" })).toBe("Extra high");
  });

  it("sentence-cases split provider labels", () => {
    expect(formatThinkingOptionLabel({ id: "extra_high", label: "extra_high" })).toBe("Extra high");
    expect(formatThinkingOptionLabel({ id: "think-hard", label: "think-hard" })).toBe("Think hard");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh" })).toBe("Extra high");
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
      explicitThinkingOptionId: "high",
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinking).toBe("High");
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
      explicitThinkingOptionId: null,
    });

    expect(selection.activeModelId).toBe("default");
    expect(selection.displayModel).toBe("Default (Sonnet 4.6)");
    expect(selection.selectedThinkingId).toBe("low");
    expect(selection.displayThinking).toBe("Low");
  });

  it("reads out the runtime thinking level while keeping the configured one selected", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "xhigh" },
          ],
          defaultThinkingOptionId: "low",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      explicitThinkingOptionId: "high",
      effectiveThinkingOptionId: "xhigh",
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinkingId).toBe("xhigh");
    expect(selection.displayThinking).toBe("Extra high");
  });

  it("reads an off-catalog runtime thinking level verbatim instead of the first option", () => {
    const selection = resolveAgentModelSelection({
      models: [
        {
          id: "a",
          provider: "codex",
          label: "Model A",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "medium",
        },
      ],
      runtimeModelId: "a",
      configuredModelId: null,
      explicitThinkingOptionId: "medium",
      effectiveThinkingOptionId: "xhigh",
    });

    expect(selection.selectedThinkingId).toBe("medium");
    expect(selection.displayThinkingId).toBe("xhigh");
    expect(selection.displayThinking).toBe("Extra high");
  });

  it("keeps reading the configured level when the daemon sent no effective value", () => {
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
      explicitThinkingOptionId: "high",
    });

    expect(selection.displayThinkingId).toBe("high");
    expect(selection.displayThinking).toBe("High");
  });

  it("falls back to the model default when the runtime reports no thinking level", () => {
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
      explicitThinkingOptionId: "high",
      effectiveThinkingOptionId: null,
    });

    expect(selection.selectedThinkingId).toBe("high");
    expect(selection.displayThinkingId).toBe("low");
    expect(selection.displayThinking).toBe("Low");
  });
});

const CLAUDE_MODELS: AgentModelDefinition[] = [
  {
    id: "claude-sonnet-4-5",
    provider: "claude",
    label: "Sonnet 4.5",
    isDefault: true,
    thinkingOptions: [
      { id: "none", label: "none" },
      { id: "high", label: "high" },
    ],
    defaultThinkingOptionId: "none",
  },
  {
    id: "claude-opus-4-5",
    provider: "claude",
    label: "Opus 4.5",
    thinkingOptions: [
      { id: "high", label: "high" },
      { id: "xhigh", label: "xhigh" },
    ],
    defaultThinkingOptionId: "high",
  },
];

describe("resolveAgentModelDisplay", () => {
  it("labels the runtime model and the runtime thinking level", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: {
          model: "claude-sonnet-4-5",
          runtimeModelId: "claude-opus-4-5",
          thinkingOptionId: "high",
          effectiveThinkingOptionId: "xhigh",
        },
      }),
    ).toEqual({
      modelId: "claude-opus-4-5",
      modelLabel: "Opus 4.5",
      thinkingOptionId: "xhigh",
      thinkingLabel: "Extra high",
    });
  });

  it("reports nothing when the agent has not said what it is running", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: null, runtimeModelId: null, thinkingOptionId: null },
      }),
    ).toEqual({
      modelId: null,
      modelLabel: null,
      thinkingOptionId: null,
      thinkingLabel: null,
    });
  });

  it("never substitutes the provider default for an unreported model", () => {
    const display = resolveAgentModelDisplay({
      models: CLAUDE_MODELS,
      source: { effectiveThinkingOptionId: "high" },
    });

    expect(display.modelLabel).toBe(null);
    expect(display.thinkingLabel).toBe("High");
  });

  it("keeps an unrecognized model id verbatim rather than guessing", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: null, runtimeModelId: "claude-opus-9-0-20991231" },
      }),
    ).toMatchObject({
      modelId: "claude-opus-9-0-20991231",
      modelLabel: "claude-opus-9-0-20991231",
    });
  });

  it("keeps an unrecognized runtime model verbatim even when a configured model exists", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: "claude-sonnet-4-5", runtimeModelId: "claude-opus-9-0-20991231" },
      }),
    ).toMatchObject({
      modelId: "claude-opus-9-0-20991231",
      modelLabel: "claude-opus-9-0-20991231",
    });
  });

  it("falls back to the raw model id when the providers snapshot is unavailable", () => {
    expect(
      resolveAgentModelDisplay({
        models: null,
        source: { model: "claude-opus-4-5", thinkingOptionId: "xhigh" },
      }),
    ).toEqual({
      modelId: "claude-opus-4-5",
      modelLabel: "claude-opus-4-5",
      thinkingOptionId: "xhigh",
      thinkingLabel: "Extra high",
    });
  });

  it("uses the model default thinking level when nothing is configured", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: "claude-opus-4-5" },
      }),
    ).toMatchObject({ modelLabel: "Opus 4.5", thinkingLabel: "High" });
  });

  it("prefers the configured thinking level when the daemon sent no effective value", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: "claude-opus-4-5", thinkingOptionId: "xhigh" },
      }).thinkingLabel,
    ).toBe("Extra high");
  });

  it("prefers the model default when the runtime explicitly reports no thinking level", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: {
          model: "claude-opus-4-5",
          thinkingOptionId: "xhigh",
          effectiveThinkingOptionId: null,
        },
      }).thinkingLabel,
    ).toBe("High");
  });

  it("treats a 'default' thinking id as unset", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { model: "claude-opus-4-5", effectiveThinkingOptionId: "default" },
      }).thinkingOptionId,
    ).toBe("high");
  });

  it("reports no thinking level for a recorded turn that did not report one", () => {
    // The model default describes what the model would do, not what this turn
    // did; on a completed turn that is a fabricated history entry.
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { runtimeModelId: "claude-opus-4-5", effectiveThinkingOptionId: null },
        thinkingFallback: "none",
      }),
    ).toEqual({
      modelId: "claude-opus-4-5",
      modelLabel: "Opus 4.5",
      thinkingOptionId: null,
      thinkingLabel: null,
    });
  });

  it("still reports a thinking level the turn did record", () => {
    expect(
      resolveAgentModelDisplay({
        models: CLAUDE_MODELS,
        source: { runtimeModelId: "claude-opus-4-5", effectiveThinkingOptionId: "xhigh" },
        thinkingFallback: "none",
      }).thinkingLabel,
    ).toBe("Extra high");
  });
});

describe("formatAgentModelDisplayMeta", () => {
  it("joins the model and thinking labels", () => {
    expect(
      formatAgentModelDisplayMeta({
        modelId: "a",
        modelLabel: "Opus 4.5",
        thinkingOptionId: "high",
        thinkingLabel: "High",
      }),
    ).toBe("Opus 4.5 · High");
  });

  it("returns null when neither label is known", () => {
    expect(
      formatAgentModelDisplayMeta({
        modelId: null,
        modelLabel: null,
        thinkingOptionId: null,
        thinkingLabel: null,
      }),
    ).toBe(null);
  });

  it("renders a thinking-only meta when the model is unknown", () => {
    expect(
      formatAgentModelDisplayMeta({
        modelId: null,
        modelLabel: null,
        thinkingOptionId: "high",
        thinkingLabel: "High",
      }),
    ).toBe("High");
  });
});
