import { describe, expect, it } from "vitest";
import type {
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@server/server/agent/agent-sdk-types";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import {
  buildProviderSelectorProviders,
  buildSelectableProviderSelectorProviders,
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
  matchesModelSearch,
  resolveSelectedModelLabel,
  resolveSubmissionReadiness,
} from "./provider-selection";

describe("combined model selector data", () => {
  const codexModel: AgentModelDefinition = {
    provider: "codex",
    id: "gpt-5.4",
    label: "GPT-5.4",
  };

  function snapshotEntry(
    overrides: Partial<ProviderSnapshotEntry> & Pick<ProviderSnapshotEntry, "provider">,
  ): ProviderSnapshotEntry {
    return {
      ...overrides,
      provider: overrides.provider,
      status: overrides.status ?? "ready",
      enabled: overrides.enabled ?? true,
      label: overrides.label ?? overrides.provider,
      description: overrides.description ?? `${overrides.provider} provider`,
      defaultModeId: overrides.defaultModeId ?? "default",
      modes: overrides.modes ?? [],
      models: overrides.models ?? [codexModel],
    };
  }

  it("builds selector providers from ready enabled snapshot entries", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "codex",
          label: "Codex",
          models: [codexModel],
        }),
      ]),
    ).toEqual([
      {
        id: "codex",
        label: "Codex",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "codex:gpt-5.4",
              provider: "codex",
              providerLabel: "Codex",
              modelId: "gpt-5.4",
              modelLabel: "GPT-5.4",
              description: undefined,
              isDefault: undefined,
            },
          ],
        },
      },
    ]);
  });

  it("represents ready enabled providers without explicit models as provider-default selection", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "deepseek-tui",
          label: "DeepSeek TUI",
          models: [],
        }),
      ]),
    ).toEqual([
      {
        id: "deepseek-tui",
        label: "DeepSeek TUI",
        modelSelection: { kind: "providerDefault", label: "Default" },
      },
    ]);
  });

  it("excludes disabled providers from selector data", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "deepseek-tui",
          label: "DeepSeek TUI",
          enabled: false,
          models: [],
        }),
      ]),
    ).toEqual([]);
  });

  it("excludes providers that are not ready", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({ provider: "loading-provider", status: "loading", models: [] }),
        snapshotEntry({ provider: "error-provider", status: "error", models: [] }),
        snapshotEntry({ provider: "unavailable-provider", status: "unavailable", models: [] }),
      ]),
    ).toEqual([]);
  });

  it("builds selector providers from an already-curated provider list", () => {
    const providerDefinitions: AgentProviderDefinition[] = [
      {
        id: "codex",
        label: "Codex",
        description: "Codex provider",
        defaultModeId: "auto",
        modes: [],
      },
    ];

    expect(
      buildProviderSelectorProviders({
        providerDefinitions,
        modelsByProvider: new Map([["codex", [codexModel]]]),
      }),
    ).toEqual([
      {
        id: "codex",
        label: "Codex",
        modelSelection: {
          kind: "models",
          rows: [
            expect.objectContaining({
              provider: "codex",
              providerLabel: "Codex",
              modelId: "gpt-5.4",
              modelLabel: "GPT-5.4",
            }),
          ],
        },
      },
    ]);
  });

  it("matches across label, provider, and description with multi-token fuzzy search", () => {
    const row = {
      favoriteKey: "opencode:opencode-zen/kimi-k2.5",
      provider: "opencode",
      providerLabel: "OpenCode",
      modelId: "opencode-zen/kimi-k2.5",
      modelLabel: "Kimi K2.5",
      description: "OpenCode Zen - kimi",
    };

    expect(matchesModelSearch(row, "kimi zen")).toBe(true);
    expect(matchesModelSearch(row, "zen kimi")).toBe(true);
    expect(matchesModelSearch(row, "k2.5 zen")).toBe(true);
    expect(matchesModelSearch(row, "kimi gemini")).toBe(false);
  });

  it("ranks model search results by fuzzy match quality", () => {
    const rows = [
      {
        favoriteKey: "openai:gpt-4.1",
        provider: "openai",
        providerLabel: "OpenAI",
        modelId: "gpt-4.1",
        modelLabel: "GPT-4.1",
      },
      {
        favoriteKey: "openai:gpt-5.4",
        provider: "openai",
        providerLabel: "OpenAI",
        modelId: "gpt-5.4",
        modelLabel: "GPT-5.4",
      },
      {
        favoriteKey: "google:gemini",
        provider: "google",
        providerLabel: "Google",
        modelId: "gemini",
        modelLabel: "Gemini",
      },
    ];

    expect(filterAndRankModelRows(rows, "gpt54").map((row) => row.modelId)).toEqual(["gpt-5.4"]);
  });

  it("keeps the selected trigger label model-only", () => {
    expect(buildSelectedTriggerLabel("GPT-5.4")).toBe("GPT-5.4");
  });

  it("resolves selected labels from explicit provider model-selection state", () => {
    const providers = buildSelectableProviderSelectorProviders([
      snapshotEntry({
        provider: "codex",
        label: "Codex",
        models: [codexModel],
      }),
      snapshotEntry({
        provider: "deepseek-tui",
        label: "DeepSeek TUI",
        models: [],
      }),
    ]);

    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        isLoading: false,
      }),
    ).toBe("GPT-5.4");
    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "deepseek-tui",
        selectedModel: "",
        isLoading: false,
      }),
    ).toBe("Default");
  });

  it("returns observable submission readiness reasons", () => {
    expect(
      resolveSubmissionReadiness({
        text: "hello",
        allowsEmptyAutoSubmit: false,
        providerCount: 1,
        selection: {
          provider: "codex",
          modelId: "",
          availableModels: [codexModel],
          isModelLoading: false,
        },
        autoSubmitConfig: null,
        workspaceDirectory: "/repo",
        hasClient: true,
      }),
    ).toEqual({
      ok: false,
      reason: "No model is available for the selected provider",
    });

    expect(
      resolveSubmissionReadiness({
        text: "hello",
        allowsEmptyAutoSubmit: false,
        providerCount: 1,
        selection: {
          provider: "deepseek-tui",
          modelId: "",
          availableModels: [],
          isModelLoading: false,
        },
        autoSubmitConfig: null,
        workspaceDirectory: "/repo",
        hasClient: true,
      }),
    ).toEqual({ ok: true });
  });
});
