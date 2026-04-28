import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-form-state";
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

function makeProviderMap(
  ...definitions: AgentProviderDefinition[]
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map(definitions.map((d) => [d.id as AgentProvider, d]));
}

const codexProviderMap = makeProviderMap(TEST_CODEX_DEFINITION);
const claudeProviderMap = makeProviderMap(TEST_CLAUDE_DEFINITION);

describe("useAgentFormState", () => {
  describe("buildProviderDefinitions", () => {
    it("returns empty array when snapshot data is unavailable", () => {
      expect(buildProviderDefinitions(undefined)).toEqual([]);
      expect(buildProviderDefinitions([])).toEqual([]);
    });

    it("builds custom provider definitions from snapshot metadata", () => {
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
        {
          provider: "claude",
          status: "ready",
          enabled: true,
          label: "Claude",
          description: "Anthropic Claude",
          defaultModeId: "default",
          modes: [{ id: "default", label: "Always Ask", icon: "ShieldCheck", colorTier: "safe" }],
        },
      ];

      const definitions = buildProviderDefinitions(entries);

      expect(definitions).toEqual([
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
        {
          id: "claude",
          label: "Claude",
          description: "Anthropic Claude",
          defaultModeId: "default",
          modes: [
            {
              id: "default",
              label: "Always Ask",
              icon: "ShieldCheck",
              colorTier: "safe",
            },
          ],
        },
      ]);
    });
  });

  describe("__private__.combineInitialValues", () => {
    it("returns undefined when no initial values and no initial server id", () => {
      expect(__private__.combineInitialValues(undefined, null)).toBeUndefined();
    });

    it("does not inject a null serverId override when initialValues are present but serverId is absent", () => {
      const combined = __private__.combineInitialValues({}, null);
      expect(combined).toEqual({});
      expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
    });

    it("injects serverId from options when provided", () => {
      expect(__private__.combineInitialValues({}, "daemon-1")).toEqual({
        serverId: "daemon-1",
      });
    });

    it("keeps other initial values without forcing serverId", () => {
      const combined = __private__.combineInitialValues({ workingDir: "/repo" }, null);
      expect(combined).toEqual({ workingDir: "/repo" });
      expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
    });

    it("respects an explicit serverId override (including null) over initialServerId", () => {
      expect(__private__.combineInitialValues({ serverId: null }, "daemon-1")).toEqual({
        serverId: null,
      });

      expect(__private__.combineInitialValues({ serverId: "daemon-2" }, "daemon-1")).toEqual({
        serverId: "daemon-2",
      });
    });
  });

  describe("__private__.mergeSelectedComposerPreferences", () => {
    it("stores the selected model for the selected provider", () => {
      expect(
        __private__.mergeSelectedComposerPreferences({
          preferences: {},
          provider: "codex",
          updates: {
            model: "gpt-5.4",
          },
        }),
      ).toEqual({
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4",
          },
        },
      });
    });

    it("preserves existing provider preferences when the selected model changes", () => {
      expect(
        __private__.mergeSelectedComposerPreferences({
          preferences: {
            provider: "claude",
            providerPreferences: {
              codex: {
                mode: "full-access",
                thinkingByModel: {
                  "gpt-5.4-mini": "medium",
                },
                featureValues: {
                  fast_mode: true,
                },
              },
              claude: {
                model: "claude-sonnet-4-6",
              },
            },
            favoriteModels: [{ provider: "codex", modelId: "gpt-5.4-mini" }],
          },
          provider: "codex",
          updates: {
            model: "gpt-5.4",
          },
        }),
      ).toEqual({
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4",
            mode: "full-access",
            thinkingByModel: {
              "gpt-5.4-mini": "medium",
            },
            featureValues: {
              fast_mode: true,
            },
          },
          claude: {
            model: "claude-sonnet-4-6",
          },
        },
        favoriteModels: [{ provider: "codex", modelId: "gpt-5.4-mini" }],
      });
    });

    it("stores mode and thinking preferences without dropping the selected model", () => {
      expect(
        __private__.mergeSelectedComposerPreferences({
          preferences: {
            provider: "codex",
            providerPreferences: {
              codex: {
                model: "gpt-5.4",
                mode: "auto",
                thinkingByModel: {
                  "gpt-5.4-mini": "low",
                },
              },
            },
          },
          provider: "codex",
          updates: {
            mode: "full-access",
            thinkingByModel: {
              "gpt-5.4": "xhigh",
            },
          },
        }),
      ).toEqual({
        provider: "codex",
        providerPreferences: {
          codex: {
            model: "gpt-5.4",
            mode: "full-access",
            thinkingByModel: {
              "gpt-5.4-mini": "low",
              "gpt-5.4": "xhigh",
            },
          },
        },
      });
    });
  });

  describe("__private__.resolveFormState", () => {
    const codexModels: AgentModelDefinition[] = [
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

    it("keeps provider, mode, and model unset on first open without preferences or explicit values", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        {},
        null,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: null,
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        makeProviderMap(TEST_CLAUDE_DEFINITION, TEST_CODEX_DEFINITION),
      );

      expect(resolved.provider).toBeNull();
      expect(resolved.modeId).toBe("");
      expect(resolved.model).toBe("");
      expect(resolved.thinkingOptionId).toBe("");
    });

    it("does not auto-select a model on fresh drafts without preferences", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "codex" },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.model).toBe("");
      expect(resolved.thinkingOptionId).toBe("");
    });

    it("auto-selects the model's default thinking option when model is preferred but thinking is not", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.model).toBe("gpt-5.3-codex");
      expect(resolved.thinkingOptionId).toBe("xhigh");
    });

    it("falls back to model default when saved thinking preference is invalid", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "codex", providerPreferences: { codex: { model: "gpt-5.3-codex" } } },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.thinkingOptionId).toBe("xhigh");
    });

    it("normalizes legacy model id 'default' from initial values to the provider default model", () => {
      const resolved = __private__.resolveFormState(
        { model: "default" },
        { provider: "codex" },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.model).toBe("gpt-5.3-codex");
    });

    it("normalizes legacy model id 'default' to the provider default model", () => {
      const resolved = __private__.resolveFormState(
        { model: "default" },
        { provider: "codex" },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.model).toBe("gpt-5.3-codex");
    });

    it("keeps an explicit initial thinking option when it is valid", () => {
      const resolved = __private__.resolveFormState(
        { model: "gpt-5.3-codex", thinkingOptionId: "low" },
        { provider: "codex" },
        codexModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        codexProviderMap,
      );

      expect(resolved.model).toBe("gpt-5.3-codex");
      expect(resolved.thinkingOptionId).toBe("low");
    });

    it("falls back to the first thinking option when the model exposes options without a provider default", () => {
      const claudeModels: AgentModelDefinition[] = [
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

      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "claude", providerPreferences: { claude: { model: "default" } } },
        claudeModels,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "claude",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        claudeProviderMap,
      );

      expect(resolved.model).toBe("default");
      expect(resolved.thinkingOptionId).toBe("low");
    });

    it("clears an invalid provider instead of falling back to the first allowed provider", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "codex" },
        null,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
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
      const resolvableProviderMap = __private__.buildProviderDefinitionMapForStatuses({
        snapshotEntries: loadingEntries,
        providerDefinitions,
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
      });

      const resolved = __private__.resolveFormState(
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
        {
          serverId: null,
          provider: "codex",
          modeId: "full-access",
          model: "gpt-5.3-codex",
          thinkingOptionId: "xhigh",
          workingDir: "",
        },
        new Set<string>(),
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
      const selectableProviderMap = __private__.buildProviderDefinitionMapForStatuses({
        snapshotEntries: entries,
        providerDefinitions,
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
      });

      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "claude" },
        null,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
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

      const selectableProviderMap = __private__.buildProviderDefinitionMapForStatuses({
        snapshotEntries: entries,
        providerDefinitions,
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready"]),
      });

      const providerDefinitionIds = [providerDefinitions[0]?.id, providerDefinitions[1]?.id];
      const snapshotProviderStates = [
        { provider: entries[0]?.provider, enabled: entries[0]?.enabled },
        { provider: entries[1]?.provider, enabled: entries[1]?.enabled },
      ];

      expect([...selectableProviderMap.keys()]).toEqual(["codex"]);
      expect(providerDefinitionIds).toEqual(["codex", "claude"]);
      expect(snapshotProviderStates).toEqual([
        { provider: "codex", enabled: true },
        { provider: "claude", enabled: false },
      ]);
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
      const resolvableProviderMap = __private__.buildProviderDefinitionMapForStatuses({
        snapshotEntries: unavailableEntries,
        providerDefinitions,
        statuses: new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]),
      });

      const resolved = __private__.resolveFormState(
        undefined,
        {},
        null,
        {
          serverId: false,
          provider: true,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "full-access",
          model: "gpt-5.3-codex",
          thinkingOptionId: "xhigh",
          workingDir: "",
        },
        new Set<string>(),
        resolvableProviderMap,
      );

      expect(resolved.provider).toBeNull();
      expect(resolved.modeId).toBe("");
      expect(resolved.model).toBe("");
      expect(resolved.thinkingOptionId).toBe("");
    });

    it("does not force fallback provider when allowed provider map is empty", () => {
      const resolved = __private__.resolveFormState(
        undefined,
        { provider: "codex" },
        null,
        {
          serverId: false,
          provider: false,
          modeId: false,
          model: false,
          thinkingOptionId: false,
          workingDir: false,
        },
        {
          serverId: null,
          provider: "codex",
          modeId: "",
          model: "",
          thinkingOptionId: "",
          workingDir: "",
        },
        new Set<string>(),
        new Map<AgentProvider, AgentProviderDefinition>(),
      );

      expect(resolved.provider).toBe("codex");
    });
  });
});
