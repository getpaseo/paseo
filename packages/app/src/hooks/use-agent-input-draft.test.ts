import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

vi.mock("./use-agent-form-state", () => ({
  useAgentFormState: () => ({
    selectedServerId: "host-1",
    setSelectedServerId: () => undefined,
    setSelectedServerIdFromUser: () => undefined,
    selectedProvider: "codex",
    setProviderFromUser: () => undefined,
    selectedMode: "auto",
    setModeFromUser: () => undefined,
    selectedModel: "",
    setModelFromUser: () => undefined,
    selectedThinkingOptionId: "",
    setThinkingOptionFromUser: () => undefined,
    workingDir: "/repo",
    setWorkingDir: () => undefined,
    setWorkingDirFromUser: () => undefined,
    providerDefinitions: [{ id: "codex", label: "Codex", modes: [{ id: "auto", label: "Auto" }] }],
    providerDefinitionMap: new Map(),
    agentDefinition: undefined,
    modeOptions: [{ id: "auto", label: "Auto" }],
    availableModels: [],
    allProviderModels: new Map(),
    isAllModelsLoading: false,
    availableThinkingOptions: [],
    isModelLoading: false,
    modelError: null,
    refreshProviderModels: () => undefined,
    setProviderAndModelFromUser: () => undefined,
    workingDirIsEmpty: false,
    persistFormPreferences: async () => undefined,
  }),
}));

let __private__: typeof import("./use-agent-input-draft").__private__;

beforeAll(async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    },
    configurable: true,
  });

  ({ __private__ } = await import("./use-agent-input-draft"));
});

describe("useAgentInputDraft", () => {
  describe("__private__.resolveDraftKey", () => {
    it("returns an object draft key string unchanged", () => {
      expect(
        __private__.resolveDraftKey({
          draftKey: "draft:key",
          selectedServerId: "host-1",
        }),
      ).toBe("draft:key");
    });

    it("resolves a computed draft key from the selected server", () => {
      expect(
        __private__.resolveDraftKey({
          draftKey: ({ selectedServerId }) => `draft:${selectedServerId ?? "none"}`,
          selectedServerId: "host-1",
        }),
      ).toBe("draft:host-1");
    });
  });

  describe("__private__.resolveEffectiveComposerModelId", () => {
    const models = [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "gpt-5.4",
        isDefault: true,
      },
      {
        provider: "codex",
        id: "gpt-5.4-mini",
        label: "gpt-5.4-mini",
      },
    ];

    it("prefers the selected model when present", () => {
      expect(
        __private__.resolveEffectiveComposerModelId({
          selectedModel: "gpt-5.4-mini",
          availableModels: models,
        }),
      ).toBe("gpt-5.4-mini");
    });

    it("returns empty string when no model selected", () => {
      expect(
        __private__.resolveEffectiveComposerModelId({
          selectedModel: "",
          availableModels: models,
        }),
      ).toBe("");
    });
  });

  describe("__private__.resolveEffectiveComposerThinkingOptionId", () => {
    const models = [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "gpt-5.4",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ];

    it("prefers the selected thinking option when present", () => {
      expect(
        __private__.resolveEffectiveComposerThinkingOptionId({
          selectedThinkingOptionId: "medium",
          availableModels: models,
          effectiveModelId: "gpt-5.4",
        }),
      ).toBe("medium");
    });

    it("falls back to the model default thinking option", () => {
      expect(
        __private__.resolveEffectiveComposerThinkingOptionId({
          selectedThinkingOptionId: "",
          availableModels: models,
          effectiveModelId: "gpt-5.4",
        }),
      ).toBe("high");
    });
  });

  describe("__private__.buildDraftComposerCommandConfig", () => {
    it("returns undefined when cwd is empty", () => {
      expect(
        __private__.buildDraftComposerCommandConfig({
          provider: "codex",
          cwd: "  ",
          modeOptions: [],
          selectedMode: "",
          effectiveModelId: "gpt-5.4",
          effectiveThinkingOptionId: "high",
        }),
      ).toBeUndefined();
    });

    it("builds the draft command config from derived composer state", () => {
      expect(
        __private__.buildDraftComposerCommandConfig({
          provider: "codex",
          cwd: "/repo",
          modeOptions: [{ id: "auto", label: "Auto" }],
          selectedMode: "auto",
          effectiveModelId: "gpt-5.4",
          effectiveThinkingOptionId: "high",
        }),
      ).toEqual({
        provider: "codex",
        cwd: "/repo",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "high",
      });
    });
  });
});
