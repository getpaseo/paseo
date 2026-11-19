import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  buildProviderDiscoveredModelLayout,
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

describe("buildProviderDiscoveredModelLayout", () => {
  const opusLatest: AgentModelDefinition = {
    provider: "claude",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    metadata: { modelFamily: "Opus" },
  };
  const opusPrevious: AgentModelDefinition = {
    provider: "claude",
    id: "claude-opus-5",
    label: "Opus 5",
    metadata: { modelFamily: "Opus" },
  };
  const sonnetLatest: AgentModelDefinition = {
    provider: "claude",
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    metadata: { modelFamily: "Sonnet" },
  };
  const sonnetPrevious: AgentModelDefinition = {
    provider: "claude",
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    metadata: { modelFamily: "Sonnet" },
  };

  it("collapses family catalogs to one representative per family", () => {
    const layout = buildProviderDiscoveredModelLayout([
      opusLatest,
      opusPrevious,
      sonnetLatest,
      sonnetPrevious,
    ]);

    expect(layout.hiddenCount).toBe(2);
    expect(layout.sections).toEqual([
      {
        key: "family:Opus",
        title: "Opus",
        models: [opusLatest],
        totalCount: 2,
      },
      {
        key: "family:Sonnet",
        title: "Sonnet",
        models: [sonnetLatest],
        totalCount: 2,
      },
    ]);
  });

  it("shows every model when expanded", () => {
    const layout = buildProviderDiscoveredModelLayout(
      [opusLatest, opusPrevious, sonnetLatest, sonnetPrevious],
      { expanded: true },
    );

    expect(layout.hiddenCount).toBe(0);
    expect(layout.sections.flatMap((section) => section.models)).toEqual([
      opusLatest,
      opusPrevious,
      sonnetLatest,
      sonnetPrevious,
    ]);
  });

  it("never hides models that do not opt into family metadata", () => {
    const layout = buildProviderDiscoveredModelLayout([piModel, grokModel]);

    expect(layout.hiddenCount).toBe(0);
    expect(layout.sections).toEqual([
      {
        key: "ungrouped",
        title: null,
        models: [piModel, grokModel],
        totalCount: 2,
      },
    ]);
  });
});
