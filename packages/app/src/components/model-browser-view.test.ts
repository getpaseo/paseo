import { describe, expect, it } from "vitest";
import type {
  ProviderSelectionModelRow,
  ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import {
  MODEL_BROWSER_CREATE_PROFILE_KEY,
  filterAndRankProfileRows,
  groupProfilesByProviderModel,
  modelBrowserModelKey,
  modelBrowserProfileKey,
  modelBrowserProviderKey,
  moveModelBrowserActiveKey,
  resolveActiveModelBrowserKey,
  resolveInitialModelBrowserView,
  resolveModelBrowserAllView,
  resolveModelBrowserKeyCommand,
  resolveModelBrowserNavItems,
  resolveModelBrowserProjection,
  resolveModelBrowserScrolling,
} from "./model-browser-view";

function provider(
  id: string,
  label: string,
  rows: ProviderSelectionModelRow[] = [],
): ProviderSelectorProvider {
  return {
    id,
    label,
    modelSelection: { kind: "models", rows },
  };
}

function modelRow(
  providerId: string,
  providerLabel: string,
  modelId: string,
  modelLabel: string,
): ProviderSelectionModelRow {
  return {
    favoriteKey: `${providerId}:${modelId}`,
    provider: providerId,
    providerLabel,
    modelId,
    modelLabel,
    description: modelId,
  };
}

describe("model browser scrolling", () => {
  it("participates in native compact bottom-sheet scrolling", () => {
    expect(resolveModelBrowserScrolling({ isNative: true, isCompact: true })).toBe("sheet");
  });

  it.each([
    { platform: "native wide", isNative: true, isCompact: false },
    { platform: "compact web", isNative: false, isCompact: true },
    { platform: "wide web", isNative: false, isCompact: false },
  ])("owns scrolling on $platform surfaces", ({ isNative, isCompact }) => {
    expect(resolveModelBrowserScrolling({ isNative, isCompact })).toBe("independent");
  });
});

describe("model browser initial view", () => {
  const codex = provider("codex", "Codex");
  const pi = provider("pi", "Pi");

  it("opens a sole provider directly", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [pi],
        selectedProvider: "",
        selectedModel: "",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the selected provider when there is one", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("opens the root so pinned profiles are reachable", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: true,
      }),
    ).toEqual({ kind: "all" });
  });

  it("opens a sole provider directly regardless of root content", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [pi],
        selectedProvider: "pi",
        selectedModel: "pi-pro",
        hasProfiles: true,
      }),
    ).toEqual({ kind: "provider", providerId: "pi", providerLabel: "Pi" });
  });

  it("falls back to the root when the selected provider is gone", () => {
    expect(
      resolveInitialModelBrowserView({
        providers: [codex, pi],
        selectedProvider: "gemini",
        selectedModel: "gemini-3",
        hasProfiles: false,
      }),
    ).toEqual({ kind: "all" });
  });
});

describe("groupProfilesByProviderModel", () => {
  it("groups profiles by provider and model, skipping profiles without a model", () => {
    const lookup = groupProfilesByProviderModel([
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "sonnet-4.6" },
      { provider: "claude", modelId: "" },
      { provider: "codex", modelId: "gpt-5.4" },
    ]);

    expect(lookup.get("claude:opus-5")).toHaveLength(2);
    expect(lookup.get("claude:sonnet-4.6")).toHaveLength(1);
    expect(lookup.get("codex:gpt-5.4")).toHaveLength(1);
    expect(lookup.has("claude:")).toBe(false);
  });

  it("trims model ids so whitespace cannot create a separate key", () => {
    const lookup = groupProfilesByProviderModel([
      { provider: "claude", modelId: "opus-5" },
      { provider: "claude", modelId: "  opus-5  " },
    ]);

    expect(lookup.get("claude:opus-5")).toHaveLength(2);
  });

  it("returns an empty map for no refs", () => {
    expect(groupProfilesByProviderModel([]).size).toBe(0);
  });
});

describe("model browser all view", () => {
  const claude = provider("claude", "Claude Code", [
    modelRow("claude", "Claude Code", "opus-5", "Opus 5"),
    modelRow("claude", "Claude Code", "sonnet-4.6", "Sonnet 4.6"),
  ]);
  const copilot = provider("copilot", "Copilot", [
    modelRow("copilot", "Copilot", "claude-opus-5", "Opus 5"),
  ]);
  const codex = provider("codex", "Codex", [modelRow("codex", "Codex", "gpt-5.4", "GPT-5.4")]);
  const providers = [claude, copilot, codex];

  it("browses providers while the query is empty", () => {
    expect(
      resolveModelBrowserAllView({
        providers,
        profiles: [],
        normalizedQuery: "",
        isSearchFocused: false,
      }),
    ).toEqual({
      kind: "browse",
    });
  });

  it("shows every searchable model as soon as empty search receives focus", () => {
    const view = resolveModelBrowserAllView({
      providers,
      profiles: [],
      normalizedQuery: "",
      isSearchFocused: true,
    });

    expect(view.kind).toBe("searchResults");
    expect(view.kind === "searchResults" ? view.rows.map((row) => row.favoriteKey) : []).toEqual([
      "claude:opus-5",
      "claude:sonnet-4.6",
      "copilot:claude-opus-5",
      "codex:gpt-5.4",
    ]);
  });

  it("ranks the same model label across every provider that offers it", () => {
    const view = resolveModelBrowserAllView({
      providers,
      profiles: [],
      normalizedQuery: "opus",
      isSearchFocused: true,
    });

    expect(view.kind).toBe("searchResults");
    expect(view.kind === "searchResults" ? view.rows.map((row) => row.favoriteKey) : []).toEqual([
      "claude:opus-5",
      "copilot:claude-opus-5",
    ]);
  });

  it("matches models by their provider label", () => {
    const view = resolveModelBrowserAllView({
      providers,
      profiles: [],
      normalizedQuery: "codex",
      isSearchFocused: true,
    });

    expect(view.kind === "searchResults" ? view.rows.map((row) => row.modelId) : []).toEqual([
      "gpt-5.4",
    ]);
  });

  it("reports no matches instead of falling back to the provider list", () => {
    expect(
      resolveModelBrowserAllView({
        providers,
        profiles: [],
        normalizedQuery: "zzzz",
        isSearchFocused: true,
      }),
    ).toEqual({ kind: "noSearchMatches" });
  });

  it("ignores providers that are still loading or errored", () => {
    const loading: ProviderSelectorProvider = {
      id: "opencode",
      label: "OpenCode",
      modelSelection: { kind: "loading" },
    };
    const failed: ProviderSelectorProvider = {
      id: "pi",
      label: "Pi",
      modelSelection: { kind: "error", message: "unavailable" },
    };

    expect(
      resolveModelBrowserAllView({
        providers: [loading, failed],
        profiles: [],
        normalizedQuery: "opus",
        isSearchFocused: true,
      }),
    ).toEqual({ kind: "noSearchMatches" });
  });
});

describe("model browser profile search", () => {
  const claude = provider("claude", "Claude Code", [
    modelRow("claude", "Claude Code", "opus-5", "Opus 5"),
  ]);
  const reviewer = { id: "reviewer", name: "Reviewer", summary: "Claude Code · Opus 5 · Plan" };
  const quick = { id: "quick", name: "Quick fix", summary: "Codex · GPT-5.4" };
  const profiles = [reviewer, quick];

  it("offers profiles whose name matches the query", () => {
    const view = resolveModelBrowserAllView({
      providers: [claude],
      profiles,
      normalizedQuery: "review",
      isSearchFocused: true,
    });

    expect(view).toEqual({ kind: "searchResults", profiles: [reviewer], rows: [] });
  });

  it("offers profiles whose summary names the queried model next to the model itself", () => {
    const view = resolveModelBrowserAllView({
      providers: [claude],
      profiles,
      normalizedQuery: "opus",
      isSearchFocused: true,
    });

    expect(view.kind === "searchResults" ? view.profiles : []).toEqual([reviewer]);
    expect(view.kind === "searchResults" ? view.rows.map((row) => row.modelId) : []).toEqual([
      "opus-5",
    ]);
  });

  it("lists every profile while the focused query is empty", () => {
    expect(filterAndRankProfileRows(profiles, "")).toEqual(profiles);
  });
});

describe("model browser keyboard navigation", () => {
  const claude = provider("claude", "Claude Code", [
    modelRow("claude", "Claude Code", "opus-5", "Opus 5"),
    modelRow("claude", "Claude Code", "sonnet-4.6", "Sonnet 4.6"),
  ]);
  const codex = provider("codex", "Codex", [modelRow("codex", "Codex", "gpt-5.4", "GPT-5.4")]);
  const providers = [claude, codex];
  const reviewer = {
    id: "reviewer",
    provider: "claude",
    name: "Reviewer",
    summary: "Claude Code · Opus 5 · Plan",
  };
  const quick = {
    id: "quick",
    provider: "codex",
    name: "Quick fix",
    summary: "Codex · GPT-5.4",
  };
  const profiles = [reviewer, quick];

  it("orders profiles before providers on the root browse view", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(items.map((item) => item.key)).toEqual([
      modelBrowserProfileKey("reviewer"),
      modelBrowserProfileKey("quick"),
      modelBrowserProviderKey("claude"),
      modelBrowserProviderKey("codex"),
    ]);
  });

  it("includes Create profile before providers when profiles are empty and editable", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles: [],
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(items.map((item) => item.key)).toEqual([
      MODEL_BROWSER_CREATE_PROFILE_KEY,
      modelBrowserProviderKey("claude"),
      modelBrowserProviderKey("codex"),
    ]);
  });

  it("omits providers when custom root browse content replaces them", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: true,
    });

    expect(items.map((item) => item.key)).toEqual([
      modelBrowserProfileKey("reviewer"),
      modelBrowserProfileKey("quick"),
    ]);
  });

  it("orders matching profiles before matching models with model indexes in search results", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "opus",
      isSearchFocused: true,
      hasCustomRootBrowseContent: false,
    });

    expect(items).toEqual([
      { key: modelBrowserProfileKey("reviewer"), kind: "profile", profileId: "reviewer" },
      {
        key: modelBrowserModelKey("claude:opus-5"),
        kind: "model",
        provider: "claude",
        modelId: "opus-5",
        modelIndex: 0,
      },
    ]);
  });

  it("orders provider profiles before models inside a provider view and skips loading providers", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "provider", providerId: "claude", providerLabel: "Claude Code" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(items.map((item) => item.key)).toEqual([
      modelBrowserProfileKey("reviewer"),
      modelBrowserModelKey("claude:opus-5"),
      modelBrowserModelKey("claude:sonnet-4.6"),
    ]);

    const loadingItems = resolveModelBrowserNavItems({
      view: { kind: "provider", providerId: "pi", providerLabel: "Pi" },
      providers: [{ id: "pi", label: "Pi", modelSelection: { kind: "loading" } }],
      profiles: null,
      showProfilesSection: false,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });
    expect(loadingItems).toEqual([]);
  });

  it("highlights the selected model in an unfiltered provider view and resets to first match on search", () => {
    const view = { kind: "provider", providerId: "claude", providerLabel: "Claude Code" } as const;
    const unfilteredItems = resolveModelBrowserNavItems({
      view,
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(
      resolveActiveModelBrowserKey({
        explicitActiveKey: null,
        items: unfilteredItems,
        view,
        normalizedQuery: "",
        selectedProvider: "claude",
        selectedModel: "sonnet-4.6",
      }),
    ).toBe(modelBrowserModelKey("claude:sonnet-4.6"));

    expect(
      resolveActiveModelBrowserKey({
        explicitActiveKey: null,
        items: unfilteredItems,
        view,
        normalizedQuery: "opus",
        selectedProvider: "claude",
        selectedModel: "sonnet-4.6",
      }),
    ).toBe(modelBrowserProfileKey("reviewer"));
  });

  it("restores preferred provider highlight when returning to the root view", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(
      resolveActiveModelBrowserKey({
        explicitActiveKey: null,
        items,
        view: { kind: "all" },
        normalizedQuery: "",
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        preferredKey: modelBrowserProviderKey("codex"),
      }),
    ).toBe(modelBrowserProviderKey("codex"));
  });

  it("omits initial highlight when suppressed on native touch until an arrow key moves selection", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(
      resolveActiveModelBrowserKey({
        explicitActiveKey: null,
        items,
        view: { kind: "all" },
        normalizedQuery: "",
        selectedProvider: "claude",
        selectedModel: "opus-5",
        suppressInitialActive: true,
      }),
    ).toBeNull();

    const firstMove = moveModelBrowserActiveKey({ items, activeKey: null, key: "ArrowDown" });
    expect(firstMove).toBe(modelBrowserProfileKey("reviewer"));
    expect(
      resolveActiveModelBrowserKey({
        explicitActiveKey: firstMove,
        items,
        view: { kind: "all" },
        normalizedQuery: "",
        selectedProvider: "claude",
        selectedModel: "opus-5",
        suppressInitialActive: true,
      }),
    ).toBe(modelBrowserProfileKey("reviewer"));

    expect(moveModelBrowserActiveKey({ items, activeKey: null, key: "ArrowUp" })).toBe(
      modelBrowserProviderKey("codex"),
    );
  });

  it("projects rendered sections and keyboard nav items from a single model", () => {
    const browse = resolveModelBrowserProjection({
      view: { kind: "all" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });
    expect(browse.kind).toBe("browse");
    if (browse.kind === "browse") {
      expect(browse.profileSection).toEqual({ kind: "profiles", rows: profiles });
      expect(browse.providers.map((entry) => entry.id)).toEqual(["claude", "codex"]);
      expect(browse.showProvidersHeading).toBe(true);
      expect(browse.isEmpty).toBe(false);
      expect(browse.navItems.map((item) => item.key)).toEqual([
        modelBrowserProfileKey("reviewer"),
        modelBrowserProfileKey("quick"),
        modelBrowserProviderKey("claude"),
        modelBrowserProviderKey("codex"),
      ]);
    }

    const providerSearch = resolveModelBrowserProjection({
      view: { kind: "provider", providerId: "claude", providerLabel: "Claude Code" },
      providers,
      profiles,
      showProfilesSection: true,
      canCreateProfileRow: true,
      normalizedQuery: "opus",
      isSearchFocused: true,
      hasCustomRootBrowseContent: false,
    });
    expect(providerSearch.kind).toBe("modelList");
    if (providerSearch.kind === "modelList") {
      expect(providerSearch.showProviderLabel).toBe(false);
      expect(providerSearch.profileSection).toEqual({
        kind: "searchProfiles",
        rows: [reviewer],
        showModelsHeading: true,
      });
      expect(providerSearch.modelRows.map((row) => row.modelId)).toEqual(["opus-5"]);
      expect(providerSearch.navItems.map((item) => item.key)).toEqual([
        modelBrowserProfileKey("reviewer"),
        modelBrowserModelKey("claude:opus-5"),
      ]);
    }

    expect(
      resolveModelBrowserProjection({
        view: { kind: "provider", providerId: "pi", providerLabel: "Pi" },
        providers: [{ id: "pi", label: "Pi", modelSelection: { kind: "error", message: "boom" } }],
        profiles: null,
        showProfilesSection: false,
        canCreateProfileRow: false,
        normalizedQuery: "",
        isSearchFocused: false,
        hasCustomRootBrowseContent: false,
      }),
    ).toEqual({
      kind: "providerError",
      providerId: "pi",
      message: "boom",
      navItems: [],
    });

    expect(
      resolveModelBrowserProjection({
        view: { kind: "all" },
        providers,
        profiles,
        showProfilesSection: true,
        canCreateProfileRow: true,
        normalizedQuery: "zzzz",
        isSearchFocused: true,
        hasCustomRootBrowseContent: false,
      }),
    ).toEqual({
      kind: "noSearchMatches",
      navItems: [],
    });
  });

  it("wraps active key movement across all items", () => {
    const items = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles: [reviewer],
      showProfilesSection: true,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(
      moveModelBrowserActiveKey({
        items,
        activeKey: modelBrowserProfileKey("reviewer"),
        key: "ArrowUp",
      }),
    ).toBe(modelBrowserProviderKey("codex"));

    expect(
      moveModelBrowserActiveKey({
        items,
        activeKey: modelBrowserProviderKey("codex"),
        key: "ArrowDown",
      }),
    ).toBe(modelBrowserProfileKey("reviewer"));
  });

  it("resolves arrow, enter, drill-down, and back commands while respecting text editing and focused controls", () => {
    const rootItems = resolveModelBrowserNavItems({
      view: { kind: "all" },
      providers,
      profiles: [reviewer],
      showProfilesSection: true,
      canCreateProfileRow: false,
      normalizedQuery: "",
      isSearchFocused: false,
      hasCustomRootBrowseContent: false,
    });

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "ArrowDown" },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toEqual({ kind: "move", nextKey: modelBrowserProviderKey("claude") });

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "ArrowDown", metaKey: true },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toBeNull();

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "ArrowRight" },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProviderKey("claude"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toEqual({ kind: "drillDown", providerId: "claude", providerLabel: "Claude Code" });

    // ArrowRight stays with the search input when query text exists.
    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "ArrowRight" },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProviderKey("claude"),
        searchQuery: "cl",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toBeNull();

    // Enter yields when a secondary button (such as Back or Edit profiles) has DOM focus.
    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "Enter" },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: true,
      }),
    ).toBeNull();

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "Enter" },
        view: { kind: "all" },
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toEqual({
      kind: "activate",
      item: { key: modelBrowserProfileKey("reviewer"), kind: "profile", profileId: "reviewer" },
    });

    const providerView = {
      kind: "provider",
      providerId: "claude",
      providerLabel: "Claude Code",
    } as const;
    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "ArrowLeft" },
        view: providerView,
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toEqual({ kind: "back", providerId: "claude" });

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "Backspace" },
        view: providerView,
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "o",
        canGoBack: true,
        focusedControlOwnsEnter: false,
      }),
    ).toBeNull();

    expect(
      resolveModelBrowserKeyCommand({
        event: { key: "Backspace" },
        view: providerView,
        items: rootItems,
        activeKey: modelBrowserProfileKey("reviewer"),
        searchQuery: "",
        canGoBack: false,
        focusedControlOwnsEnter: false,
      }),
    ).toBeNull();
  });
});
