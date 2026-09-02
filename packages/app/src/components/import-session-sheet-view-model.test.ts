import { describe, expect, it } from "vitest";
import type { FetchRecentProviderSessionEntry } from "@getpaseo/client/internal/daemon-client";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectProviderErrorRows,
  computeEmptyState,
  formatDirectoryLabel,
  getPromptPreview,
  getSessionTitle,
  hasMoreSessions,
  nextPageLimit,
  PER_PROVIDER_LIMIT,
  resolveDirectoryLabel,
  resolveImportTarget,
  resolveProvidersToFetch,
  requiresImportSessionsHostUpgrade,
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

  it("returns enabled providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude" },
      { provider: "codex" },
      { provider: "opencode", enabled: false },
      { provider: "z-ai" },
    ]);
    expect(providers).toEqual(["claude", "codex", "z-ai"]);
  });

  it("returns an empty array when snapshot has no enabled providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude", enabled: false },
      { provider: "z-ai", enabled: false },
    ]);
    expect(providers).toEqual([]);
  });
});

describe("requiresImportSessionsHostUpgrade", () => {
  it("allows home imports on hosts without workspace targeting", () => {
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: null,
        supportsWorkspaceTarget: false,
      }),
    ).toBe(false);
  });

  it("requires host support for imports opened from a workspace", () => {
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: "ws-current",
        supportsWorkspaceTarget: false,
      }),
    ).toBe(true);
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: "ws-current",
        supportsWorkspaceTarget: true,
      }),
    ).toBe(false);
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

describe("collectProviderErrorRows", () => {
  it("returns no rows when no providers are being fetched", () => {
    expect(collectProviderErrorRows(null, [], new Map())).toEqual([]);
  });

  it("returns a row for each provider whose request failed", () => {
    const rows = collectProviderErrorRows(
      ["claude", "codex"],
      [settled(undefined, { isError: true }), settled({ entries: [] })],
      new Map([["claude", "Claude Code"]]),
    );
    expect(rows).toEqual([{ provider: "claude", label: "Claude Code" }]);
  });

  it("returns a row for a provider the daemon reported as failed in a good response", () => {
    const rows = collectProviderErrorRows(
      ["codex"],
      [
        settled({
          entries: [],
          providerErrors: [{ provider: "codex", message: "timed out" }],
        }),
      ],
      new Map([["codex", "Codex"]]),
    );
    expect(rows).toEqual([{ provider: "codex", label: "Codex" }]);
  });

  it("uses provider id when the label map has no entry", () => {
    const rows = collectProviderErrorRows(
      ["codex"],
      [settled(undefined, { isError: true })],
      new Map(),
    );
    expect(rows).toEqual([{ provider: "codex", label: "codex" }]);
  });
});

describe("nextPageLimit", () => {
  it("grows the per-provider limit one step at a time", () => {
    expect(nextPageLimit(PER_PROVIDER_LIMIT)).toBe(45);
    expect(nextPageLimit(45)).toBe(90);
    expect(nextPageLimit(90)).toBe(200);
  });

  it("stops at the protocol ceiling", () => {
    expect(nextPageLimit(200)).toBe(200);
  });
});

describe("hasMoreSessions", () => {
  it("reports more when a provider filled the requested page", () => {
    expect(hasMoreSessions([settled({ entries: [entry(), entry()] })], 2)).toBe(true);
  });

  it("reports no more once every provider returned a short page", () => {
    expect(hasMoreSessions([settled({ entries: [entry()] })], 2)).toBe(false);
  });

  it("reports no more at the last page size, however full the page is", () => {
    expect(hasMoreSessions([settled({ entries: [entry(), entry()] })], 200)).toBe(false);
  });

  it("keeps reporting more while the next page replaces placeholder rows", () => {
    expect(
      hasMoreSessions([settled({ entries: [entry()] }, { isPlaceholderData: true })], 45),
    ).toBe(true);
  });
});

describe("resolveDirectoryLabel", () => {
  const projects = [
    { rootPath: "/home/me/paseo", name: "paseo" },
    { rootPath: "/home/me/paseo/packages/app", name: "paseo app" },
  ];

  it("names the project root after the project alone", () => {
    expect(resolveDirectoryLabel("/home/me/paseo", projects)).toEqual({ name: "paseo" });
  });

  it("qualifies a worktree under the project with its path below the root", () => {
    expect(
      resolveDirectoryLabel("/home/me/paseo/.dev/worktrees/abc/zebra", [projects[0]!]),
    ).toEqual({ name: "paseo", detail: ".dev/worktrees/abc/zebra" });
  });

  it("tells two worktrees of the same project apart", () => {
    const zebra = resolveDirectoryLabel("/home/me/paseo/.dev/worktrees/abc/zebra", [projects[0]!]);
    const otter = resolveDirectoryLabel("/home/me/paseo/.dev/worktrees/def/otter", [projects[0]!]);
    expect(zebra).not.toEqual(otter);
    expect([zebra.detail, otter.detail]).toEqual([
      ".dev/worktrees/abc/zebra",
      ".dev/worktrees/def/otter",
    ]);
  });

  it("picks the most specific project root containing the directory", () => {
    expect(resolveDirectoryLabel("/home/me/paseo/packages/app/src", projects)).toEqual({
      name: "paseo app",
      detail: "src",
    });
  });

  it("ignores trailing slashes on both sides", () => {
    expect(
      resolveDirectoryLabel("/home/me/paseo/", [{ rootPath: "/home/me/paseo/", name: "p" }]),
    ).toEqual({ name: "p" });
  });

  it("does not match a project root that is only a string prefix", () => {
    expect(resolveDirectoryLabel("/home/me/paseo-fork", projects)).toEqual({
      name: "/home/me/paseo-fork",
    });
  });

  it("falls back to the path when no project owns the directory", () => {
    expect(resolveDirectoryLabel("/tmp/scratch", projects)).toEqual({ name: "/tmp/scratch" });
  });
});

describe("formatDirectoryLabel", () => {
  it("shows the project name alone at its root", () => {
    expect(formatDirectoryLabel({ name: "paseo" })).toBe("paseo");
  });

  it("appends the path under the root so worktrees of one project read apart", () => {
    expect(formatDirectoryLabel({ name: "paseo", detail: ".dev/worktrees/zebra" })).toBe(
      "paseo · .dev/worktrees/zebra",
    );
  });
});

describe("resolveImportTarget", () => {
  it("trusts a scoped listing, whose rows the daemon already matched realpath-aware", () => {
    expect(
      resolveImportTarget({
        entryCwd: "/private/repo/paseo",
        workspaceCwd: "/repo/paseo",
        workspaceId: "ws-1",
        isScopedListing: true,
      }),
    ).toEqual({ workspaceId: "ws-1", crossWorkspace: false });
  });

  it("keeps the current workspace for a Show-all row in that workspace's directory", () => {
    expect(
      resolveImportTarget({
        entryCwd: "/repo/paseo/",
        workspaceCwd: "/repo/paseo",
        workspaceId: "ws-1",
        isScopedListing: false,
      }),
    ).toEqual({ workspaceId: "ws-1", crossWorkspace: false });
  });

  it("drops the workspace for a Show-all row from another directory, which the daemon rejects", () => {
    expect(
      resolveImportTarget({
        entryCwd: "/repo/other",
        workspaceCwd: "/repo/paseo",
        workspaceId: "ws-1",
        isScopedListing: false,
      }),
    ).toEqual({ crossWorkspace: true });
  });

  it("treats a sheet with no workspace as cross-workspace", () => {
    expect(resolveImportTarget({ entryCwd: "/repo/paseo", isScopedListing: false })).toEqual({
      crossWorkspace: true,
    });
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
    hasQuery: false,
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

  it("says nothing matched when a query narrowed the list to nothing", () => {
    const result = computeEmptyState({
      ...baseInputs,
      hasQuery: true,
      totalAlreadyImportedCount: 4,
    });
    expect(result.emptyStateTitle).toBe("No sessions match your search.");
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
