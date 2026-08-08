import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  buildSubagentPolicyModels,
  getNextSubagentAllowedModels,
  isSubagentModelAllowed,
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

const piModel: AgentModelDefinition = {
  provider: "pi",
  id: "pi/model",
  label: "Pi Model",
};

const grokModel: AgentModelDefinition = {
  provider: "grok",
  id: "grok-build",
  label: "Grok Build",
};

function resolveModels(input: {
  serverId?: string;
  provider: string;
  currentModels?: AgentModelDefinition[];
  loading?: boolean;
  cache?: ProviderDiscoveredModelsCache | null;
}) {
  return resolveProviderDiscoveredModels({
    serverId: input.serverId ?? "local",
    provider: input.provider,
    currentModels: input.currentModels,
    providerSnapshotRefreshing: input.loading === true,
    previousCache: input.cache ?? null,
  });
}

describe("resolveProviderDiscoveredModels", () => {
  it("keeps a provider's cached discovered models visible while that provider refreshes", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([grokModel]);
  });

  it("excludes compatibility-only models from display and cache", () => {
    const compatibilityModel: AgentModelDefinition = {
      ...piModel,
      id: "pi/model-legacy",
      label: "Pi Model legacy",
      isSelectable: false,
    };

    const result = resolveModels({
      provider: "pi",
      currentModels: [piModel, compatibilityModel],
    });

    expect(result.models).toEqual([piModel]);
    expect(result.cache?.models).toEqual([piModel]);
  });

  it("does not show one provider's cached models while another provider loads", () => {
    const ready = resolveModels({ provider: "pi", currentModels: [piModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([]);
  });

  it("does not show another server's cached models while the same provider loads", () => {
    const ready = resolveModels({
      serverId: "server-a",
      provider: "grok",
      currentModels: [grokModel],
    });

    const refreshing = resolveModels({
      serverId: "server-b",
      provider: "grok",
      loading: true,
      cache: ready.cache,
    });

    expect(refreshing.models).toEqual([]);
  });
});

describe("subagent model policy", () => {
  it("includes available models and stale configured IDs", () => {
    expect(
      buildSubagentPolicyModels({
        discoveredModels: [grokModel],
        additionalModels: [{ id: "custom/model", label: "Custom model" }],
        allowedModels: ["grok-build", "removed-model"],
        guidance: { "guided-removed-model": "Use for migrations" },
      }),
    ).toEqual([
      { id: "grok-build", label: "Grok Build", available: true },
      { id: "custom/model", label: "Custom model", available: true },
      { id: "removed-model", label: "removed-model", available: false },
      { id: "guided-removed-model", label: "guided-removed-model", available: false },
    ]);
  });

  it("treats missing and empty allowlists as unrestricted", () => {
    expect(isSubagentModelAllowed("grok-build")).toBe(true);
    expect(isSubagentModelAllowed("grok-build", [])).toBe(true);
  });

  it("materializes available IDs when restricting an unrestricted policy", () => {
    expect(
      getNextSubagentAllowedModels({
        modelId: "grok-build",
        availableModelIds: ["grok-build", "custom/model"],
        allowed: false,
      }),
    ).toEqual(["custom/model"]);
  });

  it("never returns an empty allowlist", () => {
    expect(
      getNextSubagentAllowedModels({
        modelId: "grok-build",
        allowedModels: ["grok-build"],
        availableModelIds: ["grok-build"],
        allowed: false,
      }),
    ).toBeNull();
  });
});
