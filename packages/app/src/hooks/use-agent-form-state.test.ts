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

    it("auto-selects the model's default thinking option when none is configured", () => {
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

      expect(resolved.model).toBe("gpt-5.3-codex");
      expect(resolved.thinkingOptionId).toBe("xhigh");
    });

    it("prefers provider defaults on fresh drafts", () => {
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

      expect(resolved.model).toBe("gpt-5.3-codex");
      expect(resolved.thinkingOptionId).toBe("xhigh");
    });

    it("falls back to model default when saved thinking preference is invalid", () => {
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
        { thinkingOptionId: "low" },
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
        { provider: "claude" },
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

    it("resolves provider only from allowed provider map", () => {
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

      expect(resolved.provider).toBe("claude");
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
