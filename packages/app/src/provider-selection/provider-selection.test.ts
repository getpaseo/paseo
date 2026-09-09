import { describe, expect, it } from "vitest";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { i18n } from "@/i18n/i18next";
import {
  applyModelVisibilityToProviders,
  buildProviderQualifiedDescription,
  buildProviderSelectorProviders,
  buildSelectableProviderSelectorProviders,
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
  matchesModelSearch,
  resolveEffectiveComposerModelId,
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

  it("hides compatibility-only model entries from new clients", () => {
    const compatibilityModel: AgentModelDefinition = {
      ...codexModel,
      id: "gpt-5.4-legacy",
      label: "GPT-5.4 legacy",
      isSelectable: false,
    };

    const [provider] = buildSelectableProviderSelectorProviders([
      snapshotEntry({ provider: "codex", models: [codexModel, compatibilityModel] }),
    ]);

    expect(provider?.modelSelection).toMatchObject({
      kind: "models",
      rows: [{ modelId: "gpt-5.4" }],
    });
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

  it("names the provider first when a model row is shown outside its provider", () => {
    const row = {
      favoriteKey: "copilot:claude-opus-5",
      provider: "copilot",
      providerLabel: "Copilot",
      modelId: "claude-opus-5",
      modelLabel: "Opus 5",
      description: "claude-opus-5",
    };

    expect(buildProviderQualifiedDescription(row)).toBe("Copilot · claude-opus-5");
    expect(buildProviderQualifiedDescription({ ...row, description: undefined })).toBe("Copilot");
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

  it("distinguishes a loading selection from a resolved empty selection", () => {
    expect(
      resolveSelectedModelLabel({
        providers: [],
        selectedProvider: "",
        selectedModel: "",
        isLoading: true,
      }),
    ).toBe("Loading...");
    expect(
      resolveSelectedModelLabel({
        providers: [],
        selectedProvider: "",
        selectedModel: "",
        isLoading: false,
      }),
    ).toBe("Select model");
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

describe("model visibility at the choice boundary", () => {
  const entries: ProviderSnapshotEntry[] = [
    {
      provider: "codex",
      label: "Codex",
      enabled: true,
      status: "ready",
      models: [
        { provider: "codex", id: "gpt-5.3-codex", label: "GPT-5.3", isDefault: true },
        { provider: "codex", id: "gpt-5.3-codex-mini", label: "GPT-5.3 mini" },
      ],
    } as ProviderSnapshotEntry,
    {
      provider: "claude",
      label: "Claude",
      enabled: true,
      status: "ready",
      models: [{ provider: "claude", id: "gpt-5.3-codex", label: "Same id, other provider" }],
    } as ProviderSnapshotEntry,
  ];

  it("removes hidden rows from the provider that owns them only", () => {
    const providers = applyModelVisibilityToProviders(
      buildSelectableProviderSelectorProviders(entries),
      { status: "ready", visibilityByProvider: { codex: { "gpt-5.3-codex": false } } },
    );
    expect(getAllModelLabels(providers)).toEqual(["GPT-5.3 mini", "Same id, other provider"]);
  });

  it("leaves an empty row list rather than manufacturing a synthetic default", () => {
    const providers = applyModelVisibilityToProviders(
      buildSelectableProviderSelectorProviders(entries),
      {
        status: "ready",
        visibilityByProvider: { codex: { "gpt-5.3-codex": false, "gpt-5.3-codex-mini": false } },
      },
    );
    const codex = providers.find((provider) => provider.id === "codex");
    expect(codex?.modelSelection).toEqual({ kind: "models", rows: [] });
  });

  it("keeps the synthetic default for a provider that discovered nothing", () => {
    const emptyEntry = [
      { provider: "pi", label: "Pi", enabled: true, status: "ready", models: [] },
    ] as ProviderSnapshotEntry[];
    const providers = applyModelVisibilityToProviders(
      buildSelectableProviderSelectorProviders(emptyEntry),
      { status: "ready", visibilityByProvider: { pi: {} } },
    );
    expect(getAllModelLabels(providers)).toHaveLength(1);
  });

  it("returns the same providers when the host has no preference", () => {
    const providers = buildSelectableProviderSelectorProviders(entries);
    expect(applyModelVisibilityToProviders(providers, undefined)).toBe(providers);
  });
});

describe("resolveEffectiveComposerModelId", () => {
  const models: AgentModelDefinition[] = [
    { provider: "codex", id: "gpt-5.3-codex", label: "GPT-5.3", isDefault: true },
    { provider: "codex", id: "gpt-5.3-codex-mini", label: "GPT-5.3 mini" },
  ];

  it("never launches a hidden model as the implicit default", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "",
        modeId: "",
        thinkingOptionId: "",
        availableModels: models,
        visibleModels: [models[1]],
        modeOptions: [],
      }),
    ).toBe("gpt-5.3-codex-mini");
  });

  it("sends no model when every model is hidden, so nothing hidden can be launched", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "",
        modeId: "",
        thinkingOptionId: "",
        availableModels: models,
        visibleModels: [],
        modeOptions: [],
      }),
    ).toBe("");
  });

  it("still honours an explicit selection of a hidden model", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "gpt-5.3-codex",
        modeId: "",
        thinkingOptionId: "",
        availableModels: models,
        visibleModels: [models[1]],
        modeOptions: [],
      }),
    ).toBe("gpt-5.3-codex");
  });
});

describe("submission readiness with everything hidden", () => {
  it("blocks submission instead of letting the daemon pick a hidden default", () => {
    expect(
      resolveSubmissionReadiness({
        text: "hello",
        allowsEmptyAutoSubmit: false,
        providerCount: 1,
        selection: {
          provider: "codex",
          modelId: "",
          availableModels: [{ id: "gpt-5.3-codex" }],
          isModelLoading: false,
          allModelsHidden: true,
        },
        autoSubmitConfig: null,
        workspaceDirectory: "/repo",
        hasClient: true,
      }),
    ).toEqual({
      ok: false,
      reason: "Every model for this provider is hidden. Show one in provider settings.",
    });
  });

  it("still allows a provider that genuinely discovered no models", () => {
    expect(
      resolveSubmissionReadiness({
        text: "hello",
        allowsEmptyAutoSubmit: false,
        providerCount: 1,
        selection: {
          provider: "pi",
          modelId: "",
          availableModels: [],
          isModelLoading: false,
          allModelsHidden: false,
        },
        autoSubmitConfig: null,
        workspaceDirectory: "/repo",
        hasClient: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe("model visibility load states at the picker", () => {
  const entries: ProviderSnapshotEntry[] = [
    {
      provider: "codex",
      label: "Codex",
      enabled: true,
      status: "ready",
      models: [{ provider: "codex", id: "gpt-5.3-codex", label: "GPT-5.3", isDefault: true }],
    } as ProviderSnapshotEntry,
  ];

  it("keeps pre-feature rows when the host cannot report visibility", () => {
    const providers = buildSelectableProviderSelectorProviders(entries);
    expect(
      applyModelVisibilityToProviders(providers, {
        status: "unavailable",
        visibilityByProvider: undefined,
      }),
    ).toBe(providers);
  });

  it("shows loading rather than flashing models that may be hidden", () => {
    const providers = applyModelVisibilityToProviders(
      buildSelectableProviderSelectorProviders(entries),
      { status: "loading", visibilityByProvider: undefined },
    );
    expect(providers[0]?.modelSelection).toEqual({ kind: "loading" });
  });

  it("shows a recoverable error rather than loading forever", () => {
    const providers = applyModelVisibilityToProviders(
      buildSelectableProviderSelectorProviders(entries),
      { status: "error", visibilityByProvider: undefined },
    );
    expect(providers[0]?.modelSelection).toEqual({
      kind: "error",
      message: "Could not load which models are hidden. Retry to try again.",
    });
  });
});

describe("hide-all blocks fresh choices but not explicit intent (R4)", () => {
  function readiness(selection: {
    modelId: string;
    allModelsHidden: boolean;
    autoSubmitModel?: string | null;
  }) {
    return resolveSubmissionReadiness({
      text: "go",
      allowsEmptyAutoSubmit: false,
      providerCount: 1,
      selection: {
        provider: "codex",
        modelId: selection.modelId,
        availableModels: [{ id: "gpt-5.3-codex" }],
        isModelLoading: false,
        allModelsHidden: selection.allModelsHidden,
      },
      autoSubmitConfig:
        selection.autoSubmitModel === undefined
          ? null
          : { provider: "codex", model: selection.autoSubmitModel },
      workspaceDirectory: "/repo",
      hasClient: true,
    });
  }

  it("sends an explicitly selected model even when every model is hidden", () => {
    expect(readiness({ modelId: "gpt-5.3-codex", allModelsHidden: true })).toEqual({ ok: true });
  });

  it("sends an applied profile's model even when every model is hidden", () => {
    expect(
      readiness({ modelId: "", allModelsHidden: true, autoSubmitModel: "gpt-5.3-codex" }),
    ).toEqual({ ok: true });
  });

  it("still blocks a fresh draft with nothing chosen and everything hidden", () => {
    expect(readiness({ modelId: "", allModelsHidden: true })).toEqual({
      ok: false,
      reason: "Every model for this provider is hidden. Show one in provider settings.",
    });
  });
});

describe("selected model labels come from the full catalog", () => {
  const providers = buildSelectableProviderSelectorProviders([
    {
      provider: "codex",
      label: "Codex",
      enabled: true,
      status: "ready",
      models: [{ provider: "codex", id: "gpt-5.3-codex-mini", label: "GPT-5.3 mini" }],
    } as ProviderSnapshotEntry,
  ]);

  it("keeps a hidden current model's label instead of showing its raw ID", () => {
    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "codex",
        selectedModel: "gpt-5.3-codex",
        isLoading: false,
        catalogModels: [
          { id: "gpt-5.3-codex", label: "GPT-5.3" },
          { id: "gpt-5.3-codex-mini", label: "GPT-5.3 mini" },
        ],
      }),
    ).toBe("GPT-5.3");
  });

  it("falls back to the ID when the catalog does not know the model", () => {
    expect(
      resolveSelectedModelLabel({
        providers,
        selectedProvider: "codex",
        selectedModel: "retired-model",
        isLoading: false,
        catalogModels: [{ id: "gpt-5.3-codex-mini", label: "GPT-5.3 mini" }],
      }),
    ).toBe("retired-model");
  });
});
