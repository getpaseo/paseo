import { describe, expect, it } from "vitest";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { i18n } from "@/i18n/i18next";
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
              description: "gpt-5.4",
              isDefault: undefined,
            },
          ],
        },
      },
    ]);
  });

  it("synthesizes a default model row for ready enabled providers without explicit models", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "codewhale",
          label: "CodeWhale",
          models: [],
        }),
      ]),
    ).toEqual([
      {
        id: "codewhale",
        label: "CodeWhale",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "codewhale:",
              provider: "codewhale",
              providerLabel: "CodeWhale",
              modelId: "",
              modelLabel: "Default",
              description: undefined,
              isDefault: true,
            },
          ],
        },
      },
    ]);
  });

  it("excludes disabled providers from selector data", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "codewhale",
          label: "CodeWhale",
          enabled: false,
          models: [],
        }),
      ]),
    ).toEqual([]);
  });

  it("surfaces non-ready providers with their state-specific selection", () => {
    expect(
      buildSelectableProviderSelectorProviders([
        snapshotEntry({ provider: "loading-provider", status: "loading", models: [] }),
        snapshotEntry({
          provider: "error-provider",
          status: "error",
          error: "boom",
          models: [],
        }),
        snapshotEntry({
          provider: "unavailable-provider",
          status: "unavailable",
          models: [],
        }),
      ]),
    ).toEqual([
      {
        id: "loading-provider",
        label: "loading-provider",
        modelSelection: { kind: "loading" },
      },
      {
        id: "error-provider",
        label: "error-provider",
        modelSelection: { kind: "error", message: "boom" },
      },
      {
        id: "unavailable-provider",
        label: "unavailable-provider",
        modelSelection: { kind: "error", message: "Unavailable" },
      },
    ]);
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
        provider: "codewhale",
        label: "CodeWhale",
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
        selectedProvider: "codewhale",
        selectedModel: "",
        isLoading: false,
      }),
    ).toBe("Default");
  });

  it("keeps a stored selected model visible when current snapshot rows no longer offer it", () => {
    const providers = buildSelectableProviderSelectorProviders([
      snapshotEntry({
        provider: "codex",
        label: "Codex",
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      }),
    ]);

    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "codex",
        selectedModel: "gpt-5.3",
        isLoading: false,
      }),
    ).toBe("gpt-5.3");
  });

  it("keeps provider snapshot errors visible in the selected trigger label", () => {
    const providers = buildSelectableProviderSelectorProviders([
      snapshotEntry({
        provider: "opencode",
        label: "OpenCode",
        status: "error",
        error: "OpenCode app.agents timed out after 10s",
        models: [],
      }),
    ]);

    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "opencode",
        selectedModel: "",
        isLoading: false,
      }),
    ).toBe("Error");
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
          provider: "codewhale",
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

  it("uses the active app language for utility labels", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      const providers = buildSelectableProviderSelectorProviders([
        snapshotEntry({
          provider: "deepseek-tui",
          label: "DeepSeek TUI",
          models: [],
        }),
        snapshotEntry({
          provider: "unavailable-provider",
          status: "unavailable",
          models: [],
        }),
      ]);

      expect(getAllModelLabels(providers)).toContain("默认");
      expect(providers[1]?.modelSelection).toEqual({
        kind: "error",
        message: "不可用",
      });
      expect(
        resolveSubmissionReadiness({
          text: "",
          allowsEmptyAutoSubmit: false,
          providerCount: 1,
          selection: {
            provider: "codex",
            modelId: "gpt-5.4",
            availableModels: [codexModel],
            isModelLoading: false,
          },
          autoSubmitConfig: null,
          workspaceDirectory: "/repo",
          hasClient: true,
        }),
      ).toEqual({ ok: false, reason: "初始 prompt 必填" });
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

function getAllModelLabels(providers: ReturnType<typeof buildSelectableProviderSelectorProviders>) {
  return providers.flatMap((provider) =>
    provider.modelSelection.kind === "models"
      ? provider.modelSelection.rows.map((row) => row.modelLabel)
      : [],
  );
}
