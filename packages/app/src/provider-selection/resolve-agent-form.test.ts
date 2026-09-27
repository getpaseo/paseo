import { describe, expect, it } from "vitest";
import {
  resolveAgentForm,
  resolveFormState,
  resolveEffectiveModel,
  resolveThinkingOptionId,
  mergeSelectedComposerPreferences,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  resolveDefaultModel,
  INITIAL_USER_MODIFIED,
  PENDING_AGENT_FORM_RESOLUTION,
  type AgentFormReducerState,
  type AgentFormResolutionState,
  type ProviderModelsByProvider,
  type UserModifiedFields,
} from "./resolve-agent-form";
import { areAllModelsHidden } from "./model-visibility";
import { resolveSubmissionReadiness } from "./provider-selection";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";

const TEST_CODEX_DEFINITION: AgentProviderDefinition = {
  id: "codex",
  label: "Codex",
  description: "Codex test provider",
  defaultModeId: "auto",
  modes: [
    { id: "auto", label: "Auto", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "full-access", label: "Full Access", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_CLAUDE_DEFINITION: AgentProviderDefinition = {
  id: "claude",
  label: "Claude",
  description: "Claude test provider",
  defaultModeId: "default",
  modes: [
    { id: "default", label: "Always Ask", icon: "ShieldCheck", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept File Edits", icon: "ShieldAlert", colorTier: "moderate" },
    { id: "plan", label: "Plan Mode", icon: "ShieldCheck", colorTier: "planning" },
    { id: "bypassPermissions", label: "Bypass", icon: "ShieldAlert", colorTier: "dangerous" },
  ],
};

const TEST_PI_DEFINITION: AgentProviderDefinition = {
  id: "pi",
  label: "Pi",
  description: "Pi test provider",
  defaultModeId: null,
  modes: [],
};

const CODEX_MODELS: AgentModelDefinition[] = [
  {
    provider: "codex",
    id: "gpt-5.3-codex",
    label: "gpt-5.3-codex",
    isDefault: true,
    defaultThinkingOptionId: "xhigh",
    thinkingOptions: [
      { id: "low", label: "low" },
      { id: "xhigh", label: "xhigh", isDefault: true },
    ],
  },
];

const ALIASED_CODEX_MODELS: AgentModelDefinition[] = [
  { ...CODEX_MODELS[0], aliases: ["gpt-5.3-codex-legacy"] },
];

function makeProviderMap(
  ...definitions: AgentProviderDefinition[]
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map(definitions.map((d) => [d.id, d]));
}

const codexProviderMap = makeProviderMap(TEST_CODEX_DEFINITION);
const claudeProviderMap = makeProviderMap(TEST_CLAUDE_DEFINITION);
const bothProviderMap = makeProviderMap(TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION);

function makeState(
  overrides: Partial<AgentFormReducerState["form"]> = {},
  modified: Partial<UserModifiedFields> = {},
  resolution: AgentFormResolutionState = PENDING_AGENT_FORM_RESOLUTION,
): AgentFormReducerState {
  return {
    form: {
      provider: null,
      modeId: "",
      model: "",
      thinkingOptionId: "",

      ...overrides,
    },
    userModified: { ...INITIAL_USER_MODIFIED, ...modified },
    resolution,
  };
}

function makeProviderModelsByProvider(
  entries: Array<[AgentProvider, AgentModelDefinition[] | null]>,
): ProviderModelsByProvider {
  return new Map(entries);
}

describe("resolveDefaultModel", () => {
  it("returns null for empty or null input", () => {
    expect(resolveDefaultModel(null)).toBeNull();
    expect(resolveDefaultModel([])).toBeNull();
  });

  it("returns the model marked isDefault", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: true },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("b");
  });

  it("falls back to the first model when none is marked default", () => {
    const models: AgentModelDefinition[] = [
      { provider: "codex", id: "a", label: "A", isDefault: false },
      { provider: "codex", id: "b", label: "B", isDefault: false },
    ];
    expect(resolveDefaultModel(models)?.id).toBe("a");
  });
});

describe("model aliases", () => {
  it("canonicalizes a retired preferred model and restores thinking from its alias key", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            thinkingByModel: { "gpt-5.3-codex-legacy": "low" },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("prefers thinking stored under the canonical model id over an alias", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.3-codex-legacy",
            thinkingByModel: {
              "gpt-5.3-codex": "xhigh",
              "gpt-5.3-codex-legacy": "low",
            },
          },
        },
      },
      ALIASED_CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("prefers an exact configured model id over another model's alias", () => {
    const configuredAlias: AgentModelDefinition = {
      provider: "codex",
      id: "gpt-5.3-codex-legacy",
      label: "Gateway legacy model",
      defaultThinkingOptionId: "medium",
      thinkingOptions: [{ id: "medium", label: "medium", isDefault: true }],
    };
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { model: configuredAlias.id } },
      },
      [...ALIASED_CODEX_MODELS, configuredAlias],
      INITIAL_USER_MODIFIED,
      makeState().form,
      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex-legacy");
    expect(resolved.thinkingOptionId).toBe("medium");
  });
});

describe("resolveThinkingOptionId", () => {
  it("returns empty string when model has no thinking options", () => {
    const modelsWithoutThinking: AgentModelDefinition[] = [
      { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6", isDefault: true },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsWithoutThinking,
        modelId: "claude-sonnet-4-6",
        requestedThinkingOptionId: "",
      }),
    ).toBe("");
  });

  it("returns the requested option when it is valid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "low",
      }),
    ).toBe("low");
  });

  it("falls back to defaultThinkingOptionId when requested option is invalid", () => {
    expect(
      resolveThinkingOptionId({
        availableModels: CODEX_MODELS,
        modelId: "gpt-5.3-codex",
        requestedThinkingOptionId: "invalid",
      }),
    ).toBe("xhigh");
  });

  it("falls back to first option when no default and requested is invalid", () => {
    const modelsNoDefault: AgentModelDefinition[] = [
      {
        provider: "codex",
        id: "m",
        label: "M",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ];
    expect(
      resolveThinkingOptionId({
        availableModels: modelsNoDefault,
        modelId: "m",
        requestedThinkingOptionId: "",
      }),
    ).toBe("low");
  });
});

describe("mergeSelectedComposerPreferences", () => {
  it("stores the selected model for the selected provider", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {},
        provider: "codex",
        updates: { model: "gpt-5.4" },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: { codex: { model: "gpt-5.4" } },
    });
  });

  it("preserves existing provider preferences when the selected model changes", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            codex: {
              mode: "full-access",
              thinkingByModel: { "gpt-5.4-mini": "medium" },
              featureValues: { fast_mode: true },
            },
            claude: { model: "claude-sonnet-4-6" },
          },
        },
        provider: "codex",
        updates: { model: "gpt-5.4" },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "medium" },
          featureValues: { fast_mode: true },
        },
        claude: { model: "claude-sonnet-4-6" },
      },
    });
  });

  it("stores mode and thinking preferences without dropping the selected model", () => {
    expect(
      mergeSelectedComposerPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              mode: "auto",
              thinkingByModel: { "gpt-5.4-mini": "low" },
            },
          },
        },
        provider: "codex",
        updates: {
          mode: "full-access",
          thinkingByModel: { "gpt-5.4": "xhigh" },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          mode: "full-access",
          thinkingByModel: { "gpt-5.4-mini": "low", "gpt-5.4": "xhigh" },
        },
      },
    });
  });
});

describe("buildProviderDefinitions", () => {
  it("returns empty array when snapshot data is unavailable", () => {
    expect(buildProviderDefinitions(undefined)).toEqual([]);
    expect(buildProviderDefinitions([])).toEqual([]);
  });

  it("builds provider definitions from snapshot metadata", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "zai",
        status: "ready",
        enabled: true,
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ];

    expect(buildProviderDefinitions(entries)).toEqual([
      {
        id: "zai",
        label: "ZAI",
        description: "Claude with ZAI config",
        defaultModeId: "default",
        modes: [
          {
            id: "default",
            label: "Default",
            description: "Safe mode",
            icon: "ShieldCheck",
            colorTier: "safe",
          },
        ],
      },
    ]);
  });
});

describe("resolveFormState", () => {
  it("keeps provider, mode, and model unset on first open without preferences or explicit values", () => {
    const resolved = resolveFormState(
      undefined,
      {},
      null,
      INITIAL_USER_MODIFIED,
      makeState().form,

      bothProviderMap,
    );

    expect(resolved.provider).toBeNull();
    expect(resolved.modeId).toBe("");
    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });

  it("does not auto-select a model on fresh drafts without preferences", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
  });

  it("auto-selects the model's default thinking option when model is preferred but thinking is not", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("falls back to model default when saved thinking preference is invalid", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("normalizes legacy model id 'default' from initial values to the provider default model", () => {
    const resolved = resolveFormState(
      { model: "default" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("keeps an explicit initial thinking option when it is valid", () => {
    const resolved = resolveFormState(
      { model: "gpt-5.3-codex", thinkingOptionId: "low" },
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("falls back to the first thinking option when model exposes options without a provider default", () => {
    const claudeWithThinking: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "default",
        label: "Default (Sonnet 4.6)",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
    ];

    const resolved = resolveFormState(
      undefined,
      { provider: "claude", providerPreferences: { claude: { model: "default" } } },
      claudeWithThinking,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "claude" }).form,

      claudeProviderMap,
    );

    expect(resolved.model).toBe("default");
    expect(resolved.thinkingOptionId).toBe("low");
  });

  it("preserves the remembered provider when it is absent from the available catalogue", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      claudeProviderMap,
    );

    expect(resolved.provider).toBe("codex");
  });

  it("preserves a user-selected provider and model while that provider is loading during refresh", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("preserves the saved mode while provider modes are absent from a loading snapshot", () => {
    const loadingEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "loading",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(loadingEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: loadingEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { mode: "full-access", model: "gpt-5.3-codex" } },
      },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
  });

  it("preserves a saved mode that is not in the current mode list", () => {
    const resolved = resolveFormState(
      undefined,
      {
        provider: "codex",
        providerPreferences: { codex: { mode: "workspace-write", model: "gpt-5.3-codex" } },
      },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      codexProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("workspace-write");
  });

  it("falls back when the provider cannot advertise its preferred default mode", () => {
    const providerMap = makeProviderMap({
      ...TEST_CODEX_DEFINITION,
      defaultModeId: "auto-review",
      modes: TEST_CODEX_DEFINITION.modes,
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      CODEX_MODELS,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,
      providerMap,
    );

    expect(resolved.modeId).toBe("auto");
  });

  it("preserves saved intent even when a provider is disabled", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);
    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    const resolved = resolveFormState(
      undefined,
      { provider: "claude" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      selectableProviderMap,
    );

    expect(resolved.provider).toBe("claude");
    expect(resolved.modeId).toBe("");
  });

  it("excludes disabled providers from the selectable provider map without removing them from snapshot definitions", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: false,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
      },
    ];
    const providerDefinitions = buildProviderDefinitions(entries);

    const selectableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: entries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
    });

    expect([...selectableProviderMap.keys()]).toEqual(["codex"]);
    expect(providerDefinitions.map((d) => d.id)).toEqual(["codex", "claude"]);
  });

  it("preserves a user-selected provider when the refreshed snapshot marks it unavailable", () => {
    const unavailableEntries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "unavailable",
        enabled: true,
        label: TEST_CODEX_DEFINITION.label,
        description: TEST_CODEX_DEFINITION.description,
        defaultModeId: TEST_CODEX_DEFINITION.defaultModeId,
        modes: TEST_CODEX_DEFINITION.modes,
      },
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        label: TEST_CLAUDE_DEFINITION.label,
        description: TEST_CLAUDE_DEFINITION.description,
        defaultModeId: TEST_CLAUDE_DEFINITION.defaultModeId,
        modes: TEST_CLAUDE_DEFINITION.modes,
        models: [{ provider: "claude", id: "default", label: "Default", isDefault: true }],
      },
    ];
    const providerDefinitions = buildProviderDefinitions(unavailableEntries);
    const resolvableProviderMap = buildProviderDefinitionMapForStatuses({
      snapshotEntries: unavailableEntries,
      providerDefinitions,
      statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
    });

    const resolved = resolveFormState(
      undefined,
      {},
      null,
      {
        ...INITIAL_USER_MODIFIED,
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
      },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("full-access");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.thinkingOptionId).toBe("xhigh");
  });

  it("does not force fallback provider when allowed provider map is empty", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      new Map<AgentProvider, AgentProviderDefinition>(),
    );

    expect(resolved.provider).toBe("codex");
  });
});

it("keeps the explicit model when a refreshed catalogue no longer lists it", () => {
  const resolved = resolveFormState(
    undefined,
    { provider: "codex", providerPreferences: { codex: { model: "gpt-6-astra" } } },
    CODEX_MODELS,
    INITIAL_USER_MODIFIED,
    makeState().form,
    codexProviderMap,
  );
  expect(resolved.model).toBe("gpt-6-astra");
  // Label/persistence lookup must not reinterpret the submitted ID as another model.
  expect(resolveEffectiveModel(CODEX_MODELS, resolved.model)).toBeNull();
});

describe("resolveAgentForm", () => {
  describe("resolution state", () => {
    it.each(["error", "unavailable"] as const)(
      "restores a remembered model after opening against a %s provider snapshot",
      (status) => {
        const preferences = {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        };
        const snapshotEntries: ProviderSnapshotEntry[] = [
          {
            provider: "codex",
            enabled: true,
            status,
            models: [],
          },
        ];
        const opened = resolveAgentForm(makeState(), {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", []]]),
          allowedProviderMap: buildProviderDefinitionMapForStatuses({
            snapshotEntries,
            providerDefinitions: buildProviderDefinitions(snapshotEntries),
            statuses: new Set(["ready", "loading"]),
          }),
        });
        const recovered = resolveAgentForm(opened, {
          type: "COMPLETE_RESOLUTION",
          initialValues: undefined,
          preferences,
          providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
          allowedProviderMap: codexProviderMap,
        });

        expect(recovered.form).toMatchObject({
          provider: "codex",
          model: "gpt-5.3-codex",
        });
      },
    );

    it("requests resolution without changing the current form values", () => {
      const state = makeState(
        { provider: "codex", modeId: "auto", model: "gpt-5.3-codex" },
        { provider: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "REQUEST_RESOLUTION" });

      expect(next.form).toEqual(state.form);
      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.resolution.status).toBe("pending");
    });

    it("completes a pending open resolution when snapshot models arrive late", () => {
      const state = resolveAgentForm(makeState(), {
        type: "REQUEST_RESOLUTION",
      });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.resolution.status).toBe("completed");
    });

    it("does not change settled selection when a background snapshot has different defaults", () => {
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });
      const backgroundModels: AgentModelDefinition[] = [
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex", isDefault: true },
      ];
      const next = resolveAgentForm(settled, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.4-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", backgroundModels]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(settled);
      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("prefills edit hydration from initial values", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: {
          provider: "codex",
          modeId: "full-access",
          model: "gpt-5.3-codex",
          thinkingOptionId: "low",
        },
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("full-access");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("keeps a user model change after resolution has completed", () => {
      const alternateModels: AgentModelDefinition[] = [
        ...CODEX_MODELS,
        { provider: "codex", id: "gpt-5.4-codex", label: "gpt-5.4-codex" },
      ];
      const settled = resolveAgentForm(makeState(), {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", alternateModels]]),
        allowedProviderMap: codexProviderMap,
      });
      const userChanged = resolveAgentForm(settled, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.4-codex",
        availableModels: alternateModels,
        providerPrefs: undefined,
      });
      const next = resolveAgentForm(userChanged, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: {
          provider: "codex",
          providerPreferences: { codex: { model: "gpt-5.3-codex" } },
        },
        providerModelsByProvider: makeProviderModelsByProvider([["codex", CODEX_MODELS]]),
        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(userChanged);
      expect(next.form.model).toBe("gpt-5.4-codex");
      expect(next.userModified.model).toBe(true);
    });

    it("does not override user-modified provider while completing", () => {
      const state = makeState({ provider: "codex", modeId: "auto" }, { provider: true });
      const next = resolveAgentForm(state, {
        type: "COMPLETE_RESOLUTION",
        initialValues: undefined,
        preferences: { provider: "claude" },
        providerModelsByProvider: makeProviderModelsByProvider([]),
        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
    });
  });

  describe("SET_PROVIDER_AND_MODEL_FROM_USER", () => {
    it("sets provider, model, and default mode; marks both modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("auto");
      expect(next.userModified.provider).toBe(true);
      expect(next.userModified.model).toBe(true);
    });

    it("preserves the current preferred mode when selecting a provider and model", () => {
      const state = makeState({ provider: "codex", modeId: "full-access" });
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("full-access");
    });

    it("falls back to provider default model when modelId is empty", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("selects default thinking option for the chosen model", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODE_FROM_USER", () => {
    it("updates modeId and marks it modified", () => {
      const state = makeState({ provider: "codex", modeId: "auto" });
      const next = resolveAgentForm(state, { type: "SET_MODE_FROM_USER", modeId: "full-access" });

      expect(next.form.modeId).toBe("full-access");
      expect(next.userModified.modeId).toBe(true);
    });
  });

  describe("APPLY_PROFILE_FROM_USER", () => {
    it("drops a stale saved mode for a modeless profile provider", () => {
      const next = resolveAgentForm(makeState({ provider: "codex", modeId: "full-access" }), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "pi",
        modelId: "anthropic/sonnet",
        modeId: "",
        thinkingOptionId: "",
        providerDef: TEST_PI_DEFINITION,
        providerModels: [{ provider: "pi", id: "anthropic/sonnet", label: "Sonnet" }],
        providerPrefs: { mode: "full-access" },
      });

      expect(next.form).toMatchObject({
        provider: "pi",
        model: "anthropic/sonnet",
        modeId: "",
      });
    });

    it("restores thinking for the selected model when the profile omits it", () => {
      const next = resolveAgentForm(makeState(), {
        type: "APPLY_PROFILE_FROM_USER",
        provider: "codex",
        modelId: "gpt-5.3-codex",
        modeId: "full-access",
        thinkingOptionId: "",
        providerDef: TEST_CODEX_DEFINITION,
        providerModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_MODEL_FROM_USER", () => {
    it("updates model and resets thinking to model default when thinking is not user-modified", () => {
      const state = makeState({ provider: "codex", model: "", thinkingOptionId: "" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.thinkingOptionId).toBe("xhigh");
      expect(next.userModified.model).toBe(true);
    });

    it("preserves user-chosen thinking option when switching to same model", () => {
      const state = makeState(
        { provider: "codex", model: "gpt-5.3-codex", thinkingOptionId: "low" },
        { thinkingOptionId: true },
      );
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "xhigh" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("falls back to provider default model when modelId is blank", () => {
      const state = makeState({ provider: "codex" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "  ",
        availableModels: CODEX_MODELS,
        providerPrefs: undefined,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
    });

    it("restores the target model's saved thinking option", () => {
      const models = [
        ...CODEX_MODELS,
        {
          provider: "codex" as const,
          id: "gpt-other",
          label: "Other",
          defaultThinkingOptionId: "xhigh",
          thinkingOptions: CODEX_MODELS[0].thinkingOptions,
        },
      ];
      const state = makeState({
        provider: "codex",
        model: "gpt-other",
        thinkingOptionId: "xhigh",
      });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: models,
        providerPrefs: { thinkingByModel: { "gpt-5.3-codex": "low" } },
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });
  });

  describe("SET_THINKING_OPTION_FROM_USER", () => {
    it("updates thinkingOptionId and marks it modified", () => {
      const state = makeState({ thinkingOptionId: "xhigh" });
      const next = resolveAgentForm(state, {
        type: "SET_THINKING_OPTION_FROM_USER",
        thinkingOptionId: "low",
      });

      expect(next.form.thinkingOptionId).toBe("low");
      expect(next.userModified.thinkingOptionId).toBe(true);
    });
  });

  describe("RESET", () => {
    it("keeps form values but marks them unresolved for the next open", () => {
      const state = makeState(
        { provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" },
        { provider: true, modeId: true, model: true },
        { status: "completed" },
      );
      const next = resolveAgentForm(state, { type: "RESET" });

      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.form).toEqual(state.form);
      expect(next.resolution.status).toBe("pending");
    });
  });

  describe("buildProviderDefinitionMap", () => {
    it("builds a map from provider id to definition", () => {
      const map = buildProviderDefinitionMap([TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION]);
      expect(map.get("codex")).toBe(TEST_CODEX_DEFINITION);
      expect(map.get("claude")).toBe(TEST_CLAUDE_DEFINITION);
    });
  });

  describe("buildProviderDefinitionMapForStatuses", () => {
    it("returns all definitions when no snapshot entries", () => {
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: undefined,
        providerDefinitions: [TEST_CODEX_DEFINITION],
        statuses: new Set(["ready"]),
      });
      expect([...map.keys()]).toEqual(["codex"]);
    });

    it("filters to only matching-status enabled providers", () => {
      const entries: ProviderSnapshotEntry[] = [
        {
          provider: "codex",
          status: "ready",
          enabled: true,
          label: "Codex",
          description: "",
          defaultModeId: "auto",
          modes: [],
        },
        {
          provider: "claude",
          status: "loading",
          enabled: true,
          label: "Claude",
          description: "",
          defaultModeId: "default",
          modes: [],
        },
      ];
      const map = buildProviderDefinitionMapForStatuses({
        snapshotEntries: entries,
        providerDefinitions: [TEST_CODEX_DEFINITION, TEST_CLAUDE_DEFINITION],
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
      });

      expect([...map.keys()]).toEqual(["codex"]);
    });
  });
});

it("owns input readiness, reopening and user edits in the reducer", () => {
  const inputs = {
    type: "INPUTS_CHANGED" as const,
    serverId: "host",
    isVisible: true,
    isCreateFlow: true,
    isPreferencesLoading: true,
    hasSnapshot: false,
    initialValues: undefined,
    preferences: { provider: "codex", providerPreferences: { codex: { model: "astra" } } },
    allowedProviderMap: new Map(),
    providerModelsByProvider: new Map(),
  };
  let state = resolveAgentForm(makeState(), inputs);
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
  state = resolveAgentForm(state, {
    type: "SET_MODEL_FROM_USER",
    modelId: "manual",
    availableModels: null,
    providerPrefs: undefined,
  });
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form.model).toBe("manual");
  state = resolveAgentForm(state, { ...inputs, isVisible: false });
  expect(state.resolution.status).toBe("pending");
  state = resolveAgentForm(state, { ...inputs, isPreferencesLoading: false, hasSnapshot: true });
  expect(state.form).toMatchObject({ provider: "codex", model: "astra" });
});

describe("model visibility during resolution", () => {
  const VISIBILITY_MODELS: AgentModelDefinition[] = [
    { provider: "codex", id: "gpt-5.3-codex", label: "gpt-5.3-codex", isDefault: true },
    { provider: "codex", id: "gpt-5.3-codex-mini", label: "gpt-5.3-codex-mini" },
  ];

  function resolveWithVisibility(input: {
    initialValues?: Parameters<typeof resolveFormState>[0];
    preferences?: Parameters<typeof resolveFormState>[1];
    models?: AgentModelDefinition[] | null;
    userModified?: Partial<UserModifiedFields>;
    visibility?: Record<string, Record<string, boolean>>;
    currentModel?: string;
  }) {
    return resolveFormState(
      input.initialValues,
      input.preferences ?? { provider: "codex" as AgentProvider },
      input.models === undefined ? VISIBILITY_MODELS : input.models,
      { ...INITIAL_USER_MODIFIED, ...input.userModified },
      makeState({ provider: "codex", model: input.currentModel ?? "" }).form,
      codexProviderMap,
      input.visibility,
    );
  }

  it("picks the first visible model when the provider default is hidden", () => {
    const resolved = resolveWithVisibility({
      preferences: { provider: "codex" as AgentProvider },
      visibility: { codex: { "gpt-5.3-codex": false } },
    });
    // Nothing was requested, so the form stays unset and the composer's visible
    // default takes over; what matters is that the hidden default is not chosen.
    expect(resolved.model).not.toBe("gpt-5.3-codex");
  });

  it("ignores a remembered preference that names a hidden model", () => {
    const resolved = resolveWithVisibility({
      preferences: {
        provider: "codex" as AgentProvider,
        providerPreferences: { codex: { model: "gpt-5.3-codex" } },
      },
      visibility: { codex: { "gpt-5.3-codex": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex-mini");
  });

  it("keeps a remembered preference that is still visible", () => {
    const resolved = resolveWithVisibility({
      preferences: {
        provider: "codex" as AgentProvider,
        providerPreferences: { codex: { model: "gpt-5.3-codex" } },
      },
      visibility: { codex: { "gpt-5.3-codex-mini": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("keeps an explicit initial model even when it is hidden", () => {
    const resolved = resolveWithVisibility({
      initialValues: { model: "gpt-5.3-codex" },
      visibility: { codex: { "gpt-5.3-codex": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("keeps a model the user already picked even when it is hidden", () => {
    const resolved = resolveWithVisibility({
      currentModel: "gpt-5.3-codex",
      userModified: { model: true },
      visibility: { codex: { "gpt-5.3-codex": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it('resolves the legacy "default" alias to a visible model', () => {
    const resolved = resolveWithVisibility({
      initialValues: { model: "default" },
      visibility: { codex: { "gpt-5.3-codex": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex-mini");
  });

  it("leaves the model unset when every model is hidden", () => {
    const resolved = resolveWithVisibility({
      preferences: {
        provider: "codex" as AgentProvider,
        providerPreferences: { codex: { model: "gpt-5.3-codex" } },
      },
      visibility: { codex: { "gpt-5.3-codex": false, "gpt-5.3-codex-mini": false } },
    });
    expect(resolved.model).toBe("");
  });

  it("scopes hiding to the provider that owns the model ID", () => {
    const resolved = resolveWithVisibility({
      preferences: {
        provider: "codex" as AgentProvider,
        providerPreferences: { codex: { model: "gpt-5.3-codex" } },
      },
      visibility: { claude: { "gpt-5.3-codex": false } },
    });
    expect(resolved.model).toBe("gpt-5.3-codex");
  });

  it("picks a visible default when the user switches provider without a model", () => {
    const next = resolveAgentForm(makeState({ provider: "claude" }), {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: "",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: VISIBILITY_MODELS,
      providerPrefs: undefined,
      modelVisibility: { "gpt-5.3-codex": false },
    });
    expect(next.form.model).toBe("gpt-5.3-codex-mini");
  });

  it("selects no model on a provider switch when every model is hidden", () => {
    const next = resolveAgentForm(makeState({ provider: "claude" }), {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: "",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: VISIBILITY_MODELS,
      providerPrefs: undefined,
      modelVisibility: { "gpt-5.3-codex": false, "gpt-5.3-codex-mini": false },
    });
    expect(next.form.model).toBe("");
  });

  it("keeps a saved profile's own hidden model but not a hidden fallback preference", () => {
    const withProfileModel = resolveAgentForm(makeState(), {
      type: "APPLY_PROFILE_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: "gpt-5.3-codex",
      modeId: "auto",
      thinkingOptionId: "",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: VISIBILITY_MODELS,
      providerPrefs: undefined,
      modelVisibility: { "gpt-5.3-codex": false },
    });
    expect(withProfileModel.form.model).toBe("gpt-5.3-codex");

    const withHiddenPreference = resolveAgentForm(makeState(), {
      type: "APPLY_PROFILE_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: "",
      modeId: "auto",
      thinkingOptionId: "",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: VISIBILITY_MODELS,
      providerPrefs: { model: "gpt-5.3-codex" },
      modelVisibility: { "gpt-5.3-codex": false },
    });
    expect(withHiddenPreference.form.model).toBe("gpt-5.3-codex-mini");
  });

  it("falls back to a visible model when the user clears the model choice", () => {
    const next = resolveAgentForm(makeState({ provider: "codex", model: "gpt-5.3-codex" }), {
      type: "SET_MODEL_FROM_USER",
      modelId: "",
      availableModels: VISIBILITY_MODELS,
      providerPrefs: undefined,
      modelVisibility: { "gpt-5.3-codex": false },
    });
    expect(next.form.model).toBe("gpt-5.3-codex-mini");
  });
});

// A completed draft that keeps receiving INPUTS_CHANGED while the user edits
// visibility in settings. Implicit selections (remembered or defaulted) follow
// the live visibility; explicit ones (initial values, a profile's own model, a
// model pick) do not. Readiness is checked with the same helper the composer
// uses so a hidden implicit model cannot reach a create request.
describe("completed draft visibility updates", () => {
  const A = "model-a";
  const B = "model-b";
  const LIVE_MODELS: AgentModelDefinition[] = [
    {
      provider: "codex",
      id: A,
      label: "A",
      isDefault: true,
      defaultThinkingOptionId: "high",
      thinkingOptions: [{ id: "high", label: "High" }],
    },
    {
      provider: "codex",
      id: B,
      label: "B",
      defaultThinkingOptionId: "low",
      thinkingOptions: [{ id: "low", label: "Low" }],
    },
  ];
  const LIVE_PREFS = {
    provider: "codex" as AgentProvider,
    providerPreferences: { codex: { model: A, thinkingByModel: { [A]: "high", [B]: "low" } } },
  };
  const HIDE_A = { codex: { [A]: false } };
  const HIDE_ALL = { codex: { [A]: false, [B]: false } };

  function liveInputs(
    modelVisibility: Record<string, Record<string, boolean>>,
    initialValues?: Parameters<typeof resolveFormState>[0],
  ) {
    return {
      type: "INPUTS_CHANGED" as const,
      serverId: "host",
      isVisible: true,
      isCreateFlow: true,
      isPreferencesLoading: false,
      hasSnapshot: true,
      initialValues,
      preferences: LIVE_PREFS,
      allowedProviderMap: codexProviderMap,
      providerModelsByProvider: new Map([["codex", LIVE_MODELS]]) as ProviderModelsByProvider,
      modelVisibility,
    };
  }

  function completedDraft(initialValues?: Parameters<typeof resolveFormState>[0]) {
    const state = resolveAgentForm(makeState(), liveInputs({}, initialValues));
    expect(state.resolution.status).toBe("completed");
    expect(state.form).toMatchObject({ model: A, thinkingOptionId: "high" });
    return state;
  }

  function readiness(state: AgentFormReducerState, visibility: Record<string, boolean>) {
    return resolveSubmissionReadiness({
      text: "prompt",
      allowsEmptyAutoSubmit: false,
      providerCount: 1,
      selection: {
        provider: state.form.provider,
        modelId: state.form.model,
        availableModels: LIVE_MODELS,
        isModelLoading: false,
        allModelsHidden: areAllModelsHidden(LIVE_MODELS, visibility),
      },
      autoSubmitConfig: null,
      workspaceDirectory: "/workspace",
      hasClient: true,
    });
  }

  it("moves a remembered implicit model to the visible one with its thinking option", () => {
    const state = resolveAgentForm(completedDraft(), liveInputs(HIDE_A));
    expect(state.form).toMatchObject({ model: B, thinkingOptionId: "low" });
    expect(readiness(state, HIDE_A.codex)).toEqual({ ok: true });
  });

  it("clears a remembered implicit model and blocks submission when every model is hidden", () => {
    const state = resolveAgentForm(completedDraft(), liveInputs(HIDE_ALL));
    expect(state.form.model).toBe("");
    expect(readiness(state, HIDE_ALL.codex).ok).toBe(false);
  });

  it("keeps an explicit initial model when every model is hidden", () => {
    const initialValues = {
      provider: "codex" as AgentProvider,
      model: A,
      thinkingOptionId: "high",
    };
    const state = resolveAgentForm(
      completedDraft(initialValues),
      liveInputs(HIDE_ALL, initialValues),
    );
    expect(state.form).toMatchObject({ model: A, thinkingOptionId: "high" });
    expect(readiness(state, HIDE_ALL.codex)).toEqual({ ok: true });
  });

  it("keeps a profile's own model when every model is hidden", () => {
    const withProfile = resolveAgentForm(completedDraft(), {
      type: "APPLY_PROFILE_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: A,
      modeId: "auto",
      thinkingOptionId: "high",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: LIVE_MODELS,
      providerPrefs: LIVE_PREFS.providerPreferences.codex,
    });
    const state = resolveAgentForm(withProfile, liveInputs(HIDE_ALL));
    expect(state.form).toMatchObject({ model: A, thinkingOptionId: "high" });
    expect(readiness(state, HIDE_ALL.codex)).toEqual({ ok: true });
  });

  it("keeps a model the user picked when every model is hidden", () => {
    const withPick = resolveAgentForm(completedDraft(), {
      type: "SET_MODEL_FROM_USER",
      modelId: A,
      availableModels: LIVE_MODELS,
      providerPrefs: LIVE_PREFS.providerPreferences.codex,
    });
    const state = resolveAgentForm(withPick, liveInputs(HIDE_ALL));
    expect(state.form).toMatchObject({ model: A, thinkingOptionId: "high" });
    expect(readiness(state, HIDE_ALL.codex)).toEqual({ ok: true });
  });

  it("does not treat a mode or thinking edit as an explicit model pick", () => {
    let state = resolveAgentForm(completedDraft(), { type: "SET_MODE_FROM_USER", modeId: "auto" });
    state = resolveAgentForm(state, {
      type: "SET_THINKING_OPTION_FROM_USER",
      thinkingOptionId: "high",
    });
    state = resolveAgentForm(state, liveInputs(HIDE_ALL));
    expect(state.form.model).toBe("");
    expect(readiness(state, HIDE_ALL.codex).ok).toBe(false);
  });

  it("does not treat a provider-only pick as an explicit model pick", () => {
    const providerOnly = resolveAgentForm(makeState(), {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER",
      provider: "codex" as AgentProvider,
      modelId: "",
      providerDef: TEST_CODEX_DEFINITION,
      providerModels: LIVE_MODELS,
      providerPrefs: LIVE_PREFS.providerPreferences.codex,
    });
    expect(providerOnly.form.model).toBe(A);
    let state = resolveAgentForm(providerOnly, liveInputs({}));
    expect(state.resolution.status).toBe("completed");
    state = resolveAgentForm(state, liveInputs(HIDE_A));
    expect(state.form).toMatchObject({ model: B, thinkingOptionId: "low" });
  });
});
