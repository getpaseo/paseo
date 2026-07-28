import { describe, expect, it } from "vitest";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  buildAllModelsListItems,
  buildModelRowDescription,
  buildProviderModelListItems,
  countAllModels,
  type ModelBrowserListItem,
} from "./model-browser-rows";

function row(provider: string, providerLabel: string, modelId: string): ProviderSelectionModelRow {
  return {
    favoriteKey: `${provider}:${modelId}`,
    provider,
    providerLabel,
    modelId,
    modelLabel: modelId,
    description: `${modelId} description`,
  };
}

function modelsProvider(id: string, label: string, modelIds: string[]): ProviderSelectorProvider {
  return {
    id,
    label,
    modelSelection: { kind: "models", rows: modelIds.map((modelId) => row(id, label, modelId)) },
  };
}

function keysOf(items: ModelBrowserListItem[]): string[] {
  return items.map((item) => item.key);
}

const codex = modelsProvider("codex", "Codex", ["gpt-5.4", "gpt-5.4-mini"]);
const claude = modelsProvider("claude", "Claude Code", ["opus-5", "haiku-4.5"]);
const NO_FAVORITES = new Set<string>();

describe("buildAllModelsListItems", () => {
  it("groups every provider under its own heading", () => {
    const items = buildAllModelsListItems({
      providers: [codex, claude],
      favoriteKeys: NO_FAVORITES,
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    expect(keysOf(items)).toEqual([
      "heading:provider:codex",
      "model:codex:gpt-5.4",
      "model:codex:gpt-5.4-mini",
      "heading:provider:claude",
      "model:claude:opus-5",
      "model:claude:haiku-4.5",
    ]);
  });

  it("lists favorites first without colliding with their provider group keys", () => {
    const items = buildAllModelsListItems({
      providers: [codex, claude],
      favoriteKeys: new Set(["claude:opus-5"]),
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    expect(keysOf(items).slice(0, 2)).toEqual(["heading:favorites", "favorite:claude:opus-5"]);
    expect(keysOf(items)).toContain("model:claude:opus-5");
    expect(new Set(keysOf(items)).size).toBe(items.length);
  });

  it("keeps the favorites heading distinct from a provider named favorites", () => {
    const items = buildAllModelsListItems({
      providers: [modelsProvider("favorites", "Favorites provider", ["favorite-model"])],
      favoriteKeys: new Set(["favorites:favorite-model"]),
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    expect(keysOf(items)).toEqual([
      "heading:favorites",
      "favorite:favorites:favorite-model",
      "heading:provider:favorites",
      "model:favorites:favorite-model",
    ]);
  });

  it("labels the provider inline on favorites, since they sit under a shared heading", () => {
    const items = buildAllModelsListItems({
      providers: [codex, claude],
      favoriteKeys: new Set(["claude:opus-5"]),
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    const favorite = items.find((item) => item.key === "favorite:claude:opus-5");
    const grouped = items.find((item) => item.key === "model:claude:opus-5");
    expect(favorite).toMatchObject({ kind: "model", showProvider: true });
    expect(grouped).toMatchObject({ kind: "model", showProvider: false });
  });

  it("collapses groups into one ranked run when searching across providers", () => {
    const items = buildAllModelsListItems({
      providers: [codex, claude],
      favoriteKeys: NO_FAVORITES,
      favoritesLabel: "Favorites",
      normalizedQuery: "opus",
    });

    expect(keysOf(items)).toEqual(["model:claude:opus-5"]);
    expect(items[0]).toMatchObject({ showProvider: true });
  });

  it("keeps loading and failed providers visible as status headings", () => {
    const items = buildAllModelsListItems({
      providers: [
        codex,
        { id: "pi", label: "Pi", modelSelection: { kind: "loading" } },
        { id: "opencode", label: "OpenCode", modelSelection: { kind: "error", message: "boom" } },
      ],
      favoriteKeys: NO_FAVORITES,
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    expect(items).toContainEqual({
      kind: "heading",
      key: "heading:provider:pi",
      label: "Pi",
      providerId: "pi",
      status: "loading",
    });
    expect(items).toContainEqual({
      kind: "heading",
      key: "heading:provider:opencode",
      label: "OpenCode",
      providerId: "opencode",
      status: "error",
    });
  });

  it("carries providerId on group headings so a failed provider can be opened to retry", () => {
    const items = buildAllModelsListItems({
      providers: [
        codex,
        { id: "pi", label: "Pi", modelSelection: { kind: "error", message: "x" } },
      ],
      favoriteKeys: new Set(["codex:gpt-5.4"]),
      favoritesLabel: "Favorites",
      normalizedQuery: "",
    });

    const headings = items.filter((item) => item.kind === "heading");
    // The favorites heading spans providers, so it must stay non-navigable.
    expect(headings.find((item) => item.key === "heading:favorites")?.providerId).toBeUndefined();
    expect(headings.find((item) => item.key === "heading:provider:pi")).toMatchObject({
      providerId: "pi",
      status: "error",
    });
  });
});

describe("buildProviderModelListItems", () => {
  it("floats favorites to the top of an unfiltered provider list", () => {
    const items = buildProviderModelListItems({
      provider: codex,
      favoriteKeys: new Set(["codex:gpt-5.4-mini"]),
      normalizedQuery: "",
    });

    expect(keysOf(items)).toEqual(["model:codex:gpt-5.4-mini", "model:codex:gpt-5.4"]);
  });

  it("ranks by match instead of favorites once a query is typed", () => {
    const items = buildProviderModelListItems({
      provider: codex,
      favoriteKeys: new Set(["codex:gpt-5.4-mini"]),
      normalizedQuery: "gpt-5.4",
    });

    expect(keysOf(items)[0]).toBe("model:codex:gpt-5.4");
  });

  it("never labels the provider inline, because the header already names it", () => {
    const items = buildProviderModelListItems({
      provider: codex,
      favoriteKeys: NO_FAVORITES,
      normalizedQuery: "",
    });

    expect(items.every((item) => item.kind === "model" && !item.showProvider)).toBe(true);
  });
});

describe("buildModelRowDescription", () => {
  it("prefixes the provider only when asked", () => {
    const target = row("claude", "Claude Code", "opus-5");
    expect(buildModelRowDescription(target, false)).toBe("opus-5 description");
    expect(buildModelRowDescription(target, true)).toBe("Claude Code · opus-5 description");
  });

  it("falls back to the provider alone when a model has no description", () => {
    const target = { ...row("claude", "Claude Code", "opus-5"), description: undefined };
    expect(buildModelRowDescription(target, true)).toBe("Claude Code");
    expect(buildModelRowDescription(target, false)).toBeUndefined();
  });
});

describe("countAllModels", () => {
  it("counts models across providers and ignores ones with no list yet", () => {
    expect(
      countAllModels([
        codex,
        claude,
        { id: "pi", label: "Pi", modelSelection: { kind: "loading" } },
      ]),
    ).toBe(4);
  });
});
