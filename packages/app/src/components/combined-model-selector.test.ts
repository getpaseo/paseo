import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@server/server/agent/agent-sdk-types";
import {
  buildModelRows,
  buildSelectedTriggerLabel,
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
    const rows = buildModelRows(providerDefinitions, new Map([
      ["claude", claudeModels],
      ["codex", codexModels],
    ]));

    expect(rows).toEqual([
      expect.objectContaining({ providerLabel: "Claude", modelLabel: "Sonnet 4.6", modelId: "sonnet-4.6" }),
      expect.objectContaining({ providerLabel: "Codex", modelLabel: "GPT-5.4", modelId: "gpt-5.4" }),
    ]);

    expect(matchesSearch(rows[0]!, "claude")).toBe(true);
    expect(matchesSearch(rows[1]!, "gpt-5.4")).toBe(true);
  });

  it("builds an explicit trigger label for the selected provider and model", () => {
    expect(resolveProviderLabel(providerDefinitions, "codex")).toBe("Codex");
    expect(buildSelectedTriggerLabel("Codex", "GPT-5.4")).toBe("Codex: GPT-5.4");
  });
});
