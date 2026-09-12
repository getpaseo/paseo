import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  areAllModelsHidden,
  buildModelVisibilityByProvider,
  filterVisibleModelRows,
  filterVisibleModels,
  isModelVisible,
  resolveDefaultModelCandidates,
  resolveVisibleModelCandidates,
} from "./model-visibility";
import type { ProviderSelectionModelRow } from "./provider-selection";

function model(id: string, extra: Partial<AgentModelDefinition> = {}): AgentModelDefinition {
  return { provider: "claude", id, label: id, ...extra } as AgentModelDefinition;
}

function row(provider: string, modelId: string): ProviderSelectionModelRow {
  return {
    favoriteKey: `${provider}:${modelId}`,
    provider,
    providerLabel: provider,
    modelId,
    modelLabel: modelId,
  };
}

describe("isModelVisible", () => {
  it("treats an absent key as visible so new discoveries show up", () => {
    expect(isModelVisible(undefined, "opus-5")).toBe(true);
    expect(isModelVisible({}, "opus-5")).toBe(true);
    expect(isModelVisible({ "sonnet-5": false }, "opus-5")).toBe(true);
  });

  it("hides only on an explicit false", () => {
    expect(isModelVisible({ "opus-5": false }, "opus-5")).toBe(false);
    expect(isModelVisible({ "opus-5": true }, "opus-5")).toBe(true);
  });

  it("matches the exact model ID, including dots and slashes", () => {
    const visibility = { "openai/gpt-5.2": false };
    expect(isModelVisible(visibility, "openai/gpt-5.2")).toBe(false);
    expect(isModelVisible(visibility, "openai/gpt-5")).toBe(true);
    expect(isModelVisible(visibility, "gpt-5.2")).toBe(true);
  });
});

describe("filterVisibleModels", () => {
  it("keeps catalog order and drops only hidden IDs", () => {
    const models = [model("a"), model("b"), model("c")];
    expect(filterVisibleModels(models, { b: false })?.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("passes a loading catalog through as loading", () => {
    expect(filterVisibleModels(null, { a: false })).toBeNull();
  });
});

describe("resolveVisibleModelCandidates", () => {
  it("separates an empty catalog from every model being hidden", () => {
    expect(resolveVisibleModelCandidates([], {}).kind).toBe("empty-catalog");
    expect(resolveVisibleModelCandidates([model("a")], { a: false }).kind).toBe("all-hidden");
    expect(resolveVisibleModelCandidates(null, {}).kind).toBe("loading");
  });
});

describe("resolveDefaultModelCandidates", () => {
  it("offers the visible models when some remain", () => {
    const candidates = resolveDefaultModelCandidates([model("a"), model("b")], { a: false });
    expect(candidates?.map((m) => m.id)).toEqual(["b"]);
  });

  it("offers nothing when every model is hidden, so no default can be picked", () => {
    expect(resolveDefaultModelCandidates([model("a")], { a: false })).toBeNull();
  });

  it("keeps the pre-feature empty-catalog behaviour", () => {
    expect(resolveDefaultModelCandidates([], { a: false })).toEqual([]);
  });
});

describe("areAllModelsHidden", () => {
  it("is false for a provider that simply discovered nothing", () => {
    expect(areAllModelsHidden([], {})).toBe(false);
    expect(areAllModelsHidden(null, {})).toBe(false);
    expect(areAllModelsHidden([model("a")], { a: false })).toBe(true);
  });
});

describe("filterVisibleModelRows", () => {
  it("scopes hiding to the provider that owns the model ID", () => {
    const rows = [row("claude", "shared"), row("codex", "shared")];
    const filtered = filterVisibleModelRows(rows, { claude: { shared: false } });
    expect(filtered.map((r) => r.provider)).toEqual(["codex"]);
  });

  it("never hides the synthetic default row, which has no model ID", () => {
    const rows = [row("claude", "")];
    expect(filterVisibleModelRows(rows, { claude: { "": false } })).toHaveLength(1);
  });

  it("returns the input untouched when no host preference is known", () => {
    const rows = [row("claude", "a")];
    expect(filterVisibleModelRows(rows, undefined)).toBe(rows);
  });
});

describe("buildModelVisibilityByProvider", () => {
  it("keeps providers apart and drops empty maps", () => {
    expect(
      buildModelVisibilityByProvider({
        claude: { modelVisibility: { "opus-5": false } },
        codex: { modelVisibility: {} },
        opencode: {},
      }),
    ).toEqual({ claude: { "opus-5": false } });
  });

  it("survives a config with no providers", () => {
    expect(buildModelVisibilityByProvider(undefined)).toEqual({});
  });
});
