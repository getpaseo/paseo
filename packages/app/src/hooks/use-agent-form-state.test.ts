import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-form-state";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";

describe("useAgentFormState", () => {
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
      );

      expect(resolved.model).toBe("default");
      expect(resolved.thinkingOptionId).toBe("low");
    });

    it("resolves provider only from allowed provider map", () => {
      const allowedProviderMap = new Map<AgentProvider, AgentProviderDefinition>(
        AGENT_PROVIDER_DEFINITIONS.filter((definition) => definition.id === "claude").map(
          (definition) => [definition.id as AgentProvider, definition],
        ),
      );
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
        allowedProviderMap,
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
