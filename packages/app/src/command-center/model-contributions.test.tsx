import { describe, expect, it } from "vitest";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { buildModelChoiceContributions } from "./model-contributions";

function TestIcon() {
  return null;
}

function provider(input: {
  id: string;
  label: string;
  state: "models" | "error";
}): ProviderSelectorProvider {
  if (input.state === "error") {
    return {
      id: input.id,
      label: input.label,
      modelSelection: { kind: "error", message: "Unavailable" },
    };
  }
  return {
    id: input.id,
    label: input.label,
    modelSelection: {
      kind: "models",
      rows: [
        {
          favoriteKey: `${input.id}:model`,
          provider: input.id,
          providerLabel: input.label,
          modelId: "model",
          modelLabel: `${input.label} model`,
          description: undefined,
        },
      ],
    },
  };
}

describe("Command Center model choices", () => {
  it("publishes selectable providers and executes the draft owner's command", () => {
    const selections: string[] = [];
    const choices = buildModelChoiceContributions({
      serverId: "host",
      providers: [
        provider({ id: "claude", label: "Claude", state: "models" }),
        provider({ id: "codex", label: "Codex", state: "models" }),
      ],
      selectedProvider: "codex",
      selectedModelId: "model",
      groupLabel: "Model",
      searchKeywords: "model switch",
      getIcon: () => TestIcon,
      select: (selectedProvider, modelId) => selections.push(`${selectedProvider}:${modelId}`),
    });

    expect(
      choices.map((choice) => ({
        id: choice.id,
        selected: choice.presentation.kind === "choice" ? choice.presentation.selected : false,
      })),
    ).toEqual([
      { id: "host:claude:model", selected: false },
      { id: "host:codex:model", selected: true },
    ]);
    choices[0].run();
    choices[1].run();
    expect(selections).toEqual(["claude:model"]);
  });

  it("does not publish unavailable providers or no-op default rows", () => {
    const choices = buildModelChoiceContributions({
      serverId: "host",
      providers: [
        provider({ id: "unavailable", label: "Unavailable", state: "error" }),
        {
          id: "empty",
          label: "Empty",
          modelSelection: {
            kind: "models",
            rows: [
              {
                favoriteKey: "empty:",
                provider: "empty",
                providerLabel: "Empty",
                modelId: "",
                modelLabel: "Default",
                description: undefined,
              },
            ],
          },
        },
      ],
      selectedProvider: null,
      selectedModelId: null,
      groupLabel: "Model",
      searchKeywords: "model switch",
      getIcon: () => TestIcon,
      select: () => undefined,
    });

    expect(choices).toEqual([]);
  });
});
