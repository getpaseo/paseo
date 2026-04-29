import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@server/server/agent/agent-sdk-types";
import {
  buildModelRows,
  buildSelectedTriggerLabel,
  buildSuggestedRows,
  matchesSearch,
  resolveProviderLabel,
} from "./combined-model-selector.utils";

describe("combined model selector helpers", () => {
  const providerDefinitions = [
    {
      id: "claude",
      label: "Claude",
      description: "Claude provider",
      defaultModeId: "default",
      modes: [],
    },
    {
      id: "codex",
      label: "Codex",
      description: "Codex provider",
      defaultModeId: "auto",
      modes: [],
    },
  ];

  const claudeModels: AgentModelDefinition[] = [
    {
      provider: "claude",
      id: "sonnet-4.6",
      label: "Sonnet 4.6",
    },
  ];

  const codexModels: AgentModelDefinition[] = [
    {
      provider: "codex",
      id: "gpt-5.4",
      label: "GPT-5.4",
    },
  ];

  it("keeps enough data to search by model and provider name", async () => {
    const rows = buildModelRows(
      providerDefinitions,
      new Map([
        ["claude", claudeModels],
        ["codex", codexModels],
      ]),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        providerLabel: "Claude",
        modelLabel: "Sonnet 4.6",
        modelId: "sonnet-4.6",
      }),
      expect.objectContaining({
        providerLabel: "Codex",
        modelLabel: "GPT-5.4",
        modelId: "gpt-5.4",
      }),
    ]);

    expect(matchesSearch(rows[0]!, "claude")).toBe(true);
    expect(matchesSearch(rows[1]!, "gpt-5.4")).toBe(true);
  });

  it("surfaces selected and default models as suggestions without duplicating favorites", async () => {
    const rows = buildModelRows(
      providerDefinitions,
      new Map([
        [
          "claude",
          [
            { provider: "claude", id: "sonnet-4.6", label: "Sonnet 4.6", isDefault: true },
            { provider: "claude", id: "opus-4.6", label: "Opus 4.6" },
          ],
        ],
        ["codex", codexModels],
      ]),
    );

    const suggestions = buildSuggestedRows({
      rows,
      selectedProvider: "claude",
      selectedModel: "opus-4.6",
      favoriteKeys: new Set(["codex:gpt-5.4"]),
    });

    expect(suggestions.map((row) => row.modelId)).toEqual(["sonnet-4.6", "opus-4.6"]);
  });

  it("keeps the selected trigger label model-only", () => {
    expect(resolveProviderLabel(providerDefinitions, "codex")).toBe("Codex");
    expect(buildSelectedTriggerLabel("GPT-5.4")).toBe("GPT-5.4");
  });
});
