import { describe, expect, test } from "vitest";

import {
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  mapACPUsage,
} from "./acp-agent.js";

describe("mapACPUsage", () => {
  test("maps ACP usage fields into Paseo usage", () => {
    expect(
      mapACPUsage({
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedReadTokens: 5,
      }),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 5,
    });
  });
});

describe("deriveModesFromACP", () => {
  test("prefers explicit ACP mode state", () => {
    const result = deriveModesFromACP(
      [{ id: "fallback", label: "Fallback" }],
      {
        availableModes: [
          { id: "default", name: "Always Ask", description: "Prompt before tools" },
          { id: "plan", name: "Plan", description: "Read only" },
        ],
        currentModeId: "plan",
      },
      [],
    );

    expect(result).toEqual({
      modes: [
        { id: "default", label: "Always Ask", description: "Prompt before tools" },
        { id: "plan", label: "Plan", description: "Read only" },
      ],
      currentModeId: "plan",
    });
  });

  test("falls back to config options when explicit mode state is absent", () => {
    const result = deriveModesFromACP(
      [{ id: "fallback", label: "Fallback" }],
      null,
      [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "acceptEdits",
          options: [
            { value: "default", name: "Always Ask" },
            { value: "acceptEdits", name: "Accept File Edits" },
          ],
        },
      ],
    );

    expect(result).toEqual({
      modes: [
        { id: "default", label: "Always Ask", description: undefined },
        { id: "acceptEdits", label: "Accept File Edits", description: undefined },
      ],
      currentModeId: "acceptEdits",
    });
  });
});

describe("deriveModelDefinitionsFromACP", () => {
  test("attaches shared thinking options to ACP model state", () => {
    const result = deriveModelDefinitionsFromACP("claude-acp", {
      availableModels: [
        { modelId: "haiku", name: "Haiku", description: "Fast" },
        { modelId: "sonnet", name: "Sonnet", description: "Balanced" },
      ],
      currentModelId: "haiku",
    }, [
      {
        id: "reasoning",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        provider: "claude-acp",
        id: "haiku",
        label: "Haiku",
        description: "Fast",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low", description: undefined, isDefault: false, metadata: undefined },
          { id: "medium", label: "Medium", description: undefined, isDefault: true, metadata: undefined },
          { id: "high", label: "High", description: undefined, isDefault: false, metadata: undefined },
        ],
        defaultThinkingOptionId: "medium",
      },
      {
        provider: "claude-acp",
        id: "sonnet",
        label: "Sonnet",
        description: "Balanced",
        isDefault: false,
        thinkingOptions: [
          { id: "low", label: "Low", description: undefined, isDefault: false, metadata: undefined },
          { id: "medium", label: "Medium", description: undefined, isDefault: true, metadata: undefined },
          { id: "high", label: "High", description: undefined, isDefault: false, metadata: undefined },
        ],
        defaultThinkingOptionId: "medium",
      },
    ]);
  });
});
