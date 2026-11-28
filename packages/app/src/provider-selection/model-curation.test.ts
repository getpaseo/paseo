import { describe, expect, it } from "vitest";
import { partitionProviderModels } from "./model-curation";
import type { ProviderSelectionModelRow } from "./provider-selection";

function row(modelId: string, options: { legacy?: boolean } = {}): ProviderSelectionModelRow {
  return {
    favoriteKey: `pi:${modelId}`,
    provider: "pi",
    providerLabel: "Pi",
    modelId,
    modelLabel: modelId,
    ...(options.legacy ? { legacy: true } : {}),
  };
}

function ids(rows: readonly ProviderSelectionModelRow[]): string[] {
  return rows.map((candidate) => candidate.modelId);
}

describe("partitionProviderModels", () => {
  const rows = [row("a"), row("b"), row("c", { legacy: true }), row("d", { legacy: true })];

  it("shows picked models first in their picked order and folds the rest", () => {
    const partition = partitionProviderModels(rows, ["d", "a"], "a");
    expect(ids(partition.primary)).toEqual(["d", "a"]);
    expect(ids(partition.folded)).toEqual(["b", "c"]);
    expect(partition.foldKind).toBe("all");
    expect(partition.defaultExpanded).toBe(false);
  });

  it("ignores picked models the catalog no longer has", () => {
    const partition = partitionProviderModels(rows, ["gone", "b"], "");
    expect(ids(partition.primary)).toEqual(["b"]);
    expect(ids(partition.folded)).toEqual(["a", "c", "d"]);
  });

  it("falls back to folding older models when every picked model is gone", () => {
    const partition = partitionProviderModels(rows, ["gone"], "");
    expect(ids(partition.primary)).toEqual(["a", "b"]);
    expect(ids(partition.folded)).toEqual(["c", "d"]);
    expect(partition.foldKind).toBe("older");
  });

  it("folds older models when nothing is picked", () => {
    const partition = partitionProviderModels(rows, undefined, "");
    expect(ids(partition.primary)).toEqual(["a", "b"]);
    expect(ids(partition.folded)).toEqual(["c", "d"]);
    expect(partition.foldKind).toBe("older");
  });

  it("shows every model when all of them are older", () => {
    const allLegacy = [row("c", { legacy: true }), row("d", { legacy: true })];
    const partition = partitionProviderModels(allLegacy, [], "");
    expect(ids(partition.primary)).toEqual(["c", "d"]);
    expect(partition.folded).toEqual([]);
    expect(partition.foldKind).toBeNull();
  });

  it("shows every model when none is older or picked", () => {
    const partition = partitionProviderModels([row("a"), row("b")], undefined, "a");
    expect(ids(partition.primary)).toEqual(["a", "b"]);
    expect(partition.foldKind).toBeNull();
    expect(partition.defaultExpanded).toBe(false);
  });

  it("has nothing to fold when every model is picked", () => {
    const partition = partitionProviderModels([row("a"), row("b")], ["b", "a"], "a");
    expect(ids(partition.primary)).toEqual(["b", "a"]);
    expect(partition.folded).toEqual([]);
    expect(partition.foldKind).toBeNull();
  });

  it("opens the fold when the selected model is inside it", () => {
    expect(partitionProviderModels(rows, undefined, "c").defaultExpanded).toBe(true);
    expect(partitionProviderModels(rows, ["a"], "b").defaultExpanded).toBe(true);
  });
});
