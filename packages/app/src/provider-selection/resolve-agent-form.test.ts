import { describe, expect, it } from "vitest";
import {
  resolveAgentForm,
  resolveFormState,
  resolveThinkingOptionId,
  mergeSelectedComposerPreferences,
  combineInitialValues,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  resolveDefaultModel,
  INITIAL_USER_MODIFIED,
  type AgentFormReducerState,
  type UserModifiedFields,
} from "./resolve-agent-form";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@server/server/agent/agent-sdk-types";

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
): AgentFormReducerState {
  return {
    form: {
      serverId: null,
      provider: null,
      modeId: "",
      model: "",
      thinkingOptionId: "",
      workingDir: "",
      ...overrides,
    },
    userModified: { ...INITIAL_USER_MODIFIED, ...modified },
  };
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

describe("combineInitialValues", () => {
  it("returns undefined when no initial values and no initial server id", () => {
    expect(combineInitialValues(undefined, null)).toBeUndefined();
  });

  it("does not inject a null serverId override when initialValues are present but serverId is absent", () => {
    const combined = combineInitialValues({}, null);
    expect(combined).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
  });

  it("injects serverId from options when provided", () => {
    expect(combineInitialValues({}, "daemon-1")).toEqual({ serverId: "daemon-1" });
  });

  it("keeps other initial values without forcing serverId", () => {
    const combined = combineInitialValues({ workingDir: "/repo" }, null);
    expect(combined).toEqual({ workingDir: "/repo" });
    expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
  });

  it("respects an explicit serverId override (including null) over initialServerId", () => {
    expect(combineInitialValues({ serverId: null }, "daemon-1")).toEqual({ serverId: null });
    expect(combineInitialValues({ serverId: "daemon-2" }, "daemon-1")).toEqual({
      serverId: "daemon-2",
    });
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
          favoriteModels: [{ provider: "codex", modelId: "gpt-5.4-mini" }],
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
      favoriteModels: [{ provider: "codex", modelId: "gpt-5.4-mini" }],
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

  it("clears an invalid provider instead of falling back to the first allowed provider", () => {
    const resolved = resolveFormState(
      undefined,
      { provider: "codex" },
      null,
      INITIAL_USER_MODIFIED,
      makeState({ provider: "codex" }).form,

      claudeProviderMap,
    );

    expect(resolved.provider).toBeNull();
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
        serverId: false,
        provider: true,
        modeId: true,
        model: true,
        thinkingOptionId: true,
        workingDir: false,
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

  it("ignores disabled ready providers when resolving selectable defaults", () => {
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

    expect(resolved.provider).toBe("codex");
    expect(resolved.modeId).toBe("auto");
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

  it("clears a user-selected provider when the refreshed snapshot marks it unavailable", () => {
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
      { ...INITIAL_USER_MODIFIED, provider: true },
      makeState({
        provider: "codex",
        modeId: "full-access",
        model: "gpt-5.3-codex",
        thinkingOptionId: "xhigh",
      }).form,

      resolvableProviderMap,
    );

    expect(resolved.provider).toBeNull();
    expect(resolved.modeId).toBe("");
    expect(resolved.model).toBe("");
    expect(resolved.thinkingOptionId).toBe("");
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

describe("resolveAgentForm", () => {
  describe("RESOLVE", () => {
    it("applies resolved provider and mode when no user modifications", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "RESOLVE",
        initialValues: undefined,
        preferences: { provider: "codex" },
        availableModels: null,

        allowedProviderMap: codexProviderMap,
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.modeId).toBe("auto");
    });

    it("returns the same state reference when nothing changed", () => {
      const state = makeState({ provider: "codex", modeId: "auto" });
      const next = resolveAgentForm(state, {
        type: "RESOLVE",
        initialValues: undefined,
        preferences: { provider: "codex" },
        availableModels: null,

        allowedProviderMap: codexProviderMap,
      });

      expect(next).toBe(state);
    });

    it("does not override user-modified provider", () => {
      const state = makeState({ provider: "codex", modeId: "auto" }, { provider: true });
      const next = resolveAgentForm(state, {
        type: "RESOLVE",
        initialValues: undefined,
        preferences: { provider: "claude" },
        availableModels: null,

        allowedProviderMap: bothProviderMap,
      });

      expect(next.form.provider).toBe("codex");
    });
  });

  describe("SET_SERVER_ID", () => {
    it("updates serverId without marking it user-modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, { type: "SET_SERVER_ID", value: "host-1" });

      expect(next.form.serverId).toBe("host-1");
      expect(next.userModified.serverId).toBe(false);
    });
  });

  describe("SET_SERVER_ID_FROM_USER", () => {
    it("updates serverId and marks it user-modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, { type: "SET_SERVER_ID_FROM_USER", value: "host-2" });

      expect(next.form.serverId).toBe("host-2");
      expect(next.userModified.serverId).toBe(true);
    });
  });

  describe("SET_PROVIDER_FROM_USER", () => {
    it("switches provider, picks preferred model and mode, marks provider modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_FROM_USER",
        provider: "codex",
        providerModels: CODEX_MODELS,
        providerDef: TEST_CODEX_DEFINITION,
        providerPrefs: { model: "gpt-5.3-codex", mode: "full-access" },
      });

      expect(next.form.provider).toBe("codex");
      expect(next.form.model).toBe("gpt-5.3-codex");
      expect(next.form.modeId).toBe("full-access");
      expect(next.userModified.provider).toBe(true);
      expect(next.userModified.model).toBe(false);
    });

    it("falls back to provider defaults when no prefs", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_PROVIDER_FROM_USER",
        provider: "codex",
        providerModels: CODEX_MODELS,
        providerDef: TEST_CODEX_DEFINITION,
        providerPrefs: undefined,
      });

      expect(next.form.modeId).toBe("auto");
      expect(next.form.model).toBe("gpt-5.3-codex");
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
      });

      expect(next.form.thinkingOptionId).toBe("xhigh");
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

  describe("SET_MODEL_FROM_USER", () => {
    it("updates model and resets thinking to model default when thinking is not user-modified", () => {
      const state = makeState({ provider: "codex", model: "", thinkingOptionId: "" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "gpt-5.3-codex",
        availableModels: CODEX_MODELS,
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
      });

      expect(next.form.thinkingOptionId).toBe("low");
    });

    it("falls back to provider default model when modelId is blank", () => {
      const state = makeState({ provider: "codex" });
      const next = resolveAgentForm(state, {
        type: "SET_MODEL_FROM_USER",
        modelId: "  ",
        availableModels: CODEX_MODELS,
      });

      expect(next.form.model).toBe("gpt-5.3-codex");
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

  describe("SET_WORKING_DIR", () => {
    it("updates workingDir without marking it modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, { type: "SET_WORKING_DIR", value: "/home/user/proj" });

      expect(next.form.workingDir).toBe("/home/user/proj");
      expect(next.userModified.workingDir).toBe(false);
    });
  });

  describe("SET_WORKING_DIR_FROM_USER", () => {
    it("updates workingDir and marks it modified", () => {
      const state = makeState();
      const next = resolveAgentForm(state, {
        type: "SET_WORKING_DIR_FROM_USER",
        value: "/home/user/proj",
      });

      expect(next.form.workingDir).toBe("/home/user/proj");
      expect(next.userModified.workingDir).toBe(true);
    });
  });

  describe("AUTO_SELECT_SERVER", () => {
    it("sets serverId when currently null", () => {
      const state = makeState({ serverId: null });
      const next = resolveAgentForm(state, {
        type: "AUTO_SELECT_SERVER",
        candidateServerId: "host-1",
      });

      expect(next.form.serverId).toBe("host-1");
    });

    it("does not override an already-set serverId", () => {
      const state = makeState({ serverId: "existing" });
      const next = resolveAgentForm(state, {
        type: "AUTO_SELECT_SERVER",
        candidateServerId: "host-1",
      });

      expect(next).toBe(state);
    });
  });

  describe("RESET", () => {
    it("resets userModified flags while keeping form state", () => {
      const state = makeState(
        { provider: "codex", modeId: "full-access", model: "gpt-5.3-codex" },
        { provider: true, modeId: true, model: true },
      );
      const next = resolveAgentForm(state, { type: "RESET" });

      expect(next.userModified).toEqual(INITIAL_USER_MODIFIED);
      expect(next.form).toEqual(state.form);
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
