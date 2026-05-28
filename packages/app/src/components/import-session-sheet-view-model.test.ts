import { describe, expect, it } from "vitest";
import type { FetchRecentProviderSessionEntry } from "@getpaseo/client/internal/daemon-client";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectErroredProviderLabels,
  computeEmptyState,
  getPromptPreview,
  getSessionTitle,
  resolveProvidersToFetch,
  type SessionsQueryResult,
  sumFilteredAlreadyImportedCount,
} from "@/components/import-session-sheet-view-model";

function entry(
  overrides: Partial<FetchRecentProviderSessionEntry> = {},
): FetchRecentProviderSessionEntry {
  return {
    providerId: "claude",
    providerLabel: "Claude Code",
    providerHandleId: "thread-1",
    cwd: "/repo/paseo",
    title: null,
    firstPromptPreview: null,
    lastPromptPreview: null,
    lastActivityAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

function settled(
  data: SessionsQueryResult["data"],
  flags?: Partial<Omit<SessionsQueryResult, "data">>,
): SessionsQueryResult {
  return {
    data,
    isError: false,
    isLoading: false,
    isPending: false,
    ...flags,
  };
}

describe("resolveProvidersToFetch", () => {
  it("returns null when the daemon does not support provider snapshots", () => {
    expect(resolveProvidersToFetch(false, [{ provider: "claude" }])).toBeNull();
  });

  it("returns null while snapshot entries have not loaded yet", () => {
    expect(resolveProvidersToFetch(true, undefined)).toBeNull();
  });

  it("returns only enabled importable providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude" },
      { provider: "codex" },
      { provider: "opencode", enabled: false },
      { provider: "z-ai" },
    ]);
    expect(providers).toEqual(["claude", "codex"]);
  });

  it("returns an empty array when snapshot has no enabled importable providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude", enabled: false },
      { provider: "z-ai" },
    ]);
    expect(providers).toEqual([]);
  });
});

describe("buildProviderLabelMap", () => {
  it("returns an empty map when snapshot entries are missing", () => {
    expect(buildProviderLabelMap(undefined).size).toBe(0);
  });

  it("indexes labels by provider id, skipping entries without a label", () => {
    const labels = buildProviderLabelMap([
      { provider: "claude", label: "Claude Code" },
      { provider: "codex" },
      { provider: "z-ai", label: "Z.AI" },
    ]);
    expect(labels.get("claude")).toBe("Claude Code");
    expect(labels.get("codex")).toBeUndefined();
    expect(labels.get("z-ai")).toBe("Z.AI");
  });
});

describe("aggregateSessionEntries", () => {
  it("returns an empty array when no queries have data", () => {
    expect(aggregateSessionEntries([settled(undefined)])).toEqual([]);
  });

  it("dedupes by providerId+providerHandleId across query results", () => {
    const result = aggregateSessionEntries([
      settled({
        entries: [
          entry({ providerHandleId: "thread-1", lastActivityAt: "2026-04-30T10:00:00.000Z" }),
        ],
      }),
      settled({
        entries: [
          entry({ providerHandleId: "thread-1", lastActivityAt: "2026-04-30T11:00:00.000Z" }),
          entry({ providerHandleId: "thread-2", lastActivityAt: "2026-04-30T09:00:00.000Z" }),
        ],
      }),
    ]);
    expect(result.map((e) => e.providerHandleId)).toEqual(["thread-1", "thread-2"]);
  });

  it("sorts collected entries by lastActivityAt descending", () => {
    const result = aggregateSessionEntries([
      settled({
        entries: [
          entry({ providerHandleId: "old", lastActivityAt: "2026-04-29T10:00:00.000Z" }),
          entry({ providerHandleId: "new", lastActivityAt: "2026-04-30T10:00:00.000Z" }),
        ],
      }),
    ]);
    expect(result.map((e) => e.providerHandleId)).toEqual(["new", "old"]);
  });
});

describe("sumFilteredAlreadyImportedCount", () => {
  it("returns 0 when no queries report a filtered count", () => {
    expect(sumFilteredAlreadyImportedCount([settled({ entries: [] })])).toBe(0);
  });

  it("sums the filtered already-imported counts across queries", () => {
    const total = sumFilteredAlreadyImportedCount([
      settled({ entries: [], filteredAlreadyImportedCount: 2 }),
      settled({ entries: [], filteredAlreadyImportedCount: 3 }),
      settled(undefined),
    ]);
    expect(total).toBe(5);
  });
});

describe("collectErroredProviderLabels", () => {
  it("returns no labels when no providers are being fetched", () => {
    expect(collectErroredProviderLabels(null, [], new Map())).toEqual([]);
  });

  it("returns labels for each errored provider, falling back to provider id", () => {
    const labels = collectErroredProviderLabels(
      ["claude", "codex"],
      [settled(undefined, { isError: true }), settled({ entries: [] })],
      new Map([["claude", "Claude Code"]]),
    );
    expect(labels).toEqual(["Claude Code"]);
  });

  it("uses provider id when the label map has no entry", () => {
    const labels = collectErroredProviderLabels(
      ["codex"],
      [settled(undefined, { isError: true })],
      new Map(),
    );
    expect(labels).toEqual(["codex"]);
  });
});

describe("getSessionTitle", () => {
  it("prefers the trimmed title", () => {
    expect(getSessionTitle(entry({ title: "  Importable  " }))).toBe("Importable");
  });

  it("falls back to the trimmed first prompt preview when title is empty", () => {
    expect(getSessionTitle(entry({ title: "   ", firstPromptPreview: "  Hello  " }))).toBe("Hello");
  });

  it("falls back to Untitled session when both title and first prompt are blank", () => {
    expect(getSessionTitle(entry({ title: null, firstPromptPreview: "   " }))).toBe(
      "Untitled session",
    );
  });
});

describe("getPromptPreview", () => {
  it("prefers the trimmed last prompt preview", () => {
    expect(
      getPromptPreview(
        entry({ lastPromptPreview: "  later  ", firstPromptPreview: "  earlier  " }),
      ),
    ).toBe("later");
  });

  it("falls back to the first prompt preview when last is blank", () => {
    expect(
      getPromptPreview(entry({ lastPromptPreview: "   ", firstPromptPreview: "  earlier  " })),
    ).toBe("earlier");
  });

  it("falls back to a placeholder when both prompts are blank", () => {
    expect(getPromptPreview(entry({ lastPromptPreview: null, firstPromptPreview: null }))).toBe(
      "No prompt preview",
    );
  });
});

describe("computeEmptyState", () => {
  const baseInputs = {
    isLoadingSessions: false,
    allQueriesErrored: false,
    isQueryingProviders: true,
    allQueriesSettled: true,
    selectedProvider: ALL_FILTER_VALUE,
    aggregatedCount: 0,
    visibleCount: 0,
    totalAlreadyImportedCount: 0,
    providerLabelById: new Map<string, string>(),
  };

  it("hides the empty state while sessions are still loading", () => {
    const result = computeEmptyState({ ...baseInputs, isLoadingSessions: true });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state when every query errored", () => {
    const result = computeEmptyState({ ...baseInputs, allQueriesErrored: true });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state until every provider query has settled", () => {
    const result = computeEmptyState({ ...baseInputs, allQueriesSettled: false });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state when there are visible entries", () => {
    const result = computeEmptyState({
      ...baseInputs,
      aggregatedCount: 2,
      visibleCount: 2,
    });
    expect(result.showEmptyState).toBe(false);
  });

  it("shows the default no-sessions message when nothing is loaded and nothing is filtered", () => {
    const result = computeEmptyState(baseInputs);
    expect(result).toEqual({
      showEmptyState: true,
      emptyStateTitle: "No recent sessions to import.",
    });
  });

  it("shows the already-imported message when imported entries were filtered out", () => {
    const result = computeEmptyState({
      ...baseInputs,
      totalAlreadyImportedCount: 4,
    });
    expect(result.emptyStateTitle).toBe("All recent sessions are already imported.");
  });

  it("shows a provider-scoped message when a filter hides aggregated entries", () => {
    const result = computeEmptyState({
      ...baseInputs,
      selectedProvider: "claude",
      aggregatedCount: 3,
      providerLabelById: new Map([["claude", "Claude Code"]]),
    });
    expect(result.emptyStateTitle).toBe("No Claude Code sessions found.");
  });

  it("falls back to the provider id when the filtered provider lacks a label", () => {
    const result = computeEmptyState({
      ...baseInputs,
      selectedProvider: "z-ai",
      aggregatedCount: 1,
    });
    expect(result.emptyStateTitle).toBe("No z-ai sessions found.");
  });
});
