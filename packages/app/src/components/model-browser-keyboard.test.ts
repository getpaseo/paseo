import { describe, expect, it } from "vitest";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";
import type { ModelBrowserListItem } from "./model-browser-rows";
import { moveModelHighlight, resolveModelSubmitRow } from "./model-browser-keyboard";

function modelRow(provider: string, modelId: string): ProviderSelectionModelRow {
  return {
    favoriteKey: `${provider}:${modelId}`,
    provider,
    providerLabel: provider,
    modelId,
    modelLabel: modelId,
    description: modelId,
  };
}

function modelItem(provider: string, modelId: string): ModelBrowserListItem {
  return {
    kind: "model",
    key: `model:${provider}:${modelId}`,
    row: modelRow(provider, modelId),
    showProvider: false,
  };
}

const heading: ModelBrowserListItem = {
  kind: "heading",
  key: "heading:provider:codex",
  label: "Codex",
};

const items: ModelBrowserListItem[] = [
  heading,
  modelItem("codex", "gpt-5.4"),
  modelItem("codex", "gpt-5.4-mini"),
  { kind: "heading", key: "heading:provider:claude", label: "Claude Code" },
  modelItem("claude", "opus-5"),
];

describe("moveModelHighlight", () => {
  it("starts at the first model row from nothing, in either direction", () => {
    expect(moveModelHighlight({ items, highlightedKey: null, direction: "next" })).toBe(
      "model:codex:gpt-5.4",
    );
    expect(moveModelHighlight({ items, highlightedKey: null, direction: "previous" })).toBe(
      "model:codex:gpt-5.4",
    );
  });

  it("skips group headings", () => {
    expect(
      moveModelHighlight({ items, highlightedKey: "model:codex:gpt-5.4-mini", direction: "next" }),
    ).toBe("model:claude:opus-5");
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(
      moveModelHighlight({ items, highlightedKey: "model:claude:opus-5", direction: "next" }),
    ).toBe("model:claude:opus-5");
    expect(
      moveModelHighlight({ items, highlightedKey: "model:codex:gpt-5.4", direction: "previous" }),
    ).toBe("model:codex:gpt-5.4");
  });

  it("restarts at the top when the highlighted row was filtered out", () => {
    expect(
      moveModelHighlight({ items, highlightedKey: "model:codex:gone", direction: "next" }),
    ).toBe("model:codex:gpt-5.4");
  });

  it("has nothing to move to in an empty or heading-only list", () => {
    expect(moveModelHighlight({ items: [], highlightedKey: null, direction: "next" })).toBeNull();
    expect(
      moveModelHighlight({ items: [heading], highlightedKey: null, direction: "next" }),
    ).toBeNull();
  });
});

describe("resolveModelSubmitRow", () => {
  it("commits the top result when nothing is highlighted", () => {
    expect(resolveModelSubmitRow(items, null)?.modelId).toBe("gpt-5.4");
  });

  it("commits the highlighted row", () => {
    expect(resolveModelSubmitRow(items, "model:claude:opus-5")?.modelId).toBe("opus-5");
  });

  it("falls back to the top result when the highlighted row is gone", () => {
    expect(resolveModelSubmitRow(items, "model:codex:gone")?.modelId).toBe("gpt-5.4");
  });

  it("has nothing to commit without model rows", () => {
    expect(resolveModelSubmitRow([heading], null)).toBeNull();
  });
});
