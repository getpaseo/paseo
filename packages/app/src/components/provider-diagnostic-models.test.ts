import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
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
