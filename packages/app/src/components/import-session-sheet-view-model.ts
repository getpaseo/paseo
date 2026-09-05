import type { FetchRecentProviderSessionEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";

export const PER_PROVIDER_LIMIT = 15;
export const ALL_FILTER_VALUE = "__all__";

/**
 * Paging grows the per-provider limit instead of carrying an offset. The daemon
 * ranks the whole candidate set on every request, so an offset into a previous
 * ranking would drift as sessions move; refetching a larger page cannot. 200 is
 * the protocol ceiling on `limit`.
 */
const PAGE_LIMITS: readonly number[] = [PER_PROVIDER_LIMIT, 45, 90, 200];

export function nextPageLimit(limit: number): number {
  return PAGE_LIMITS.find((candidate) => candidate > limit) ?? limit;
}

export function requiresImportSessionsHostUpgrade(input: {
  supportsSnapshot: boolean;
  workspaceId?: string | null;
  supportsWorkspaceTarget: boolean;
}): boolean {
  return !input.supportsSnapshot || (Boolean(input.workspaceId) && !input.supportsWorkspaceTarget);
}

export interface SessionsQueryResult {
  data:
    | {
        entries: FetchRecentProviderSessionEntry[];
        filteredAlreadyImportedCount?: number;
        providerErrors?: Array<{ provider: string; message: string }>;
      }
    | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
  isPlaceholderData?: boolean;
}

export function resolveProvidersToFetch(
  supportsSnapshot: boolean,
  snapshotEntries: ReadonlyArray<{ provider: string; enabled?: boolean }> | undefined,
): AgentProvider[] | null {
  // COMPAT(providersSnapshot): the import-recent-sessions feature ships alongside
  // providersSnapshot (v0.1.48, 2026-04-05). Daemons older than that lack both —
  // we render an "update host" empty state instead of degrading. Drop this gate
  // when the supported daemon floor is >= v0.1.48 (target: 2026-10-05).
  if (!supportsSnapshot) return null;
  if (!snapshotEntries) return null;
  return snapshotEntries.filter((entry) => entry.enabled !== false).map((entry) => entry.provider);
}

export function buildProviderLabelMap(
  snapshotEntries: ReadonlyArray<{ provider: string; label?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!snapshotEntries) return map;
  for (const entry of snapshotEntries) {
    if (entry.label) {
      map.set(entry.provider, entry.label);
    }
  }
  return map;
}

export function aggregateSessionEntries(
  queries: ReadonlyArray<SessionsQueryResult>,
): FetchRecentProviderSessionEntry[] {
  const seen = new Set<string>();
  const collected: FetchRecentProviderSessionEntry[] = [];
  for (const query of queries) {
    if (!query.data) continue;
    for (const entry of query.data.entries) {
      const key = `${entry.providerId}:${entry.providerHandleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  collected.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  return collected;
}

export function sumFilteredAlreadyImportedCount(
  queries: ReadonlyArray<SessionsQueryResult>,
): number {
  let total = 0;
  for (const query of queries) {
    total += query.data?.filteredAlreadyImportedCount ?? 0;
  }
  return total;
}

/**
 * A provider that returned a full page may have more behind it. The daemon
 * slices to `limit` after dropping already-imported sessions, so a short page is
 * the end of that provider's list. Placeholder rows belong to the previous page,
 * so the button holds its place instead of blinking out while the next loads.
 */
export function hasMoreSessions(
  queries: ReadonlyArray<SessionsQueryResult>,
  limit: number,
): boolean {
  if (nextPageLimit(limit) === limit) return false;
  return queries.some((entryQuery) => {
    const count = entryQuery.data?.entries.length ?? 0;
    return entryQuery.isPlaceholderData ? count > 0 : count >= limit;
  });
}

export interface ProviderErrorRow {
  provider: string;
  label: string;
}

/**
 * One row per provider that could not be listed, whether the request itself
 * failed or the daemon reported the provider as failed in an otherwise good
 * response. Both mean the same thing to the user, and both retry the same way.
 */
export function collectProviderErrorRows(
  providersToFetch: AgentProvider[] | null,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): ProviderErrorRow[] {
  if (providersToFetch === null) return [];
  const rows: ProviderErrorRow[] = [];
  for (let index = 0; index < providersToFetch.length; index++) {
    const query = queries[index];
    const provider = providersToFetch[index];
    if (!query || provider === undefined) continue;
    const failed = query.isError || (query.data?.providerErrors?.length ?? 0) > 0;
    if (!failed) continue;
    rows.push({ provider, label: providerLabelById.get(provider) ?? provider });
  }
  return rows;
}

export interface DirectoryProject {
  rootPath: string;
  name: string;
}

export interface DirectoryLabel {
  /** The owning project's name, or the whole path when no project owns it. */
  name: string;
  /**
   * The directory's path under its project root, absent at the root itself.
   * Worktrees of one project all resolve to the same name, so without this the
   * sheet would show several identical headings.
   */
  detail?: string;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The project's name when the app knows the directory, else the directory itself. */
export function resolveDirectoryLabel(
  directory: string,
  projects: ReadonlyArray<DirectoryProject>,
): DirectoryLabel {
  const normalized = withoutTrailingSlash(directory);
  let bestRoot: string | null = null;
  let bestName: string | null = null;
  for (const project of projects) {
    const root = withoutTrailingSlash(project.rootPath);
    if (!root) continue;
    if (bestRoot !== null && root.length <= bestRoot.length) continue;
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    bestRoot = root;
    bestName = project.name;
  }
  if (bestRoot === null || bestName === null) {
    return { name: normalized };
  }
  const relative = normalized.slice(bestRoot.length + 1);
  return relative ? { name: bestName, detail: relative } : { name: bestName };
}

/** The one-line form a row shows under its prompt preview. */
export function formatDirectoryLabel(label: DirectoryLabel): string {
  return label.detail ? `${label.name} · ${label.detail}` : label.name;
}

export interface ImportTarget {
  /**
   * Omitted unless the row's directory is the scoped workspace's own: the daemon
   * rejects an import whose cwd does not match the requested workspace.
   */
  workspaceId?: string;
  /**
   * The agent lands in a workspace other than the one the sheet was opened from,
   * so the caller has to open that workspace instead of adding a tab here.
   */
  crossWorkspace: boolean;
}

export function resolveImportTarget(input: {
  entryCwd: string;
  /** The directory the sheet was opened for, absent when it was opened host-wide. */
  workspaceCwd?: string | null;
  workspaceId?: string | null;
  /** The listed rows came from a fetch scoped to `workspaceCwd`. */
  isScopedListing: boolean;
}): ImportTarget {
  if (!input.workspaceId || !input.workspaceCwd) {
    return { crossWorkspace: true };
  }
  // A scoped listing only holds rows the daemon already matched to this
  // workspace's directory with realpaths resolved, which the client cannot do.
  // "Show all" drops that guarantee, so each row is compared by path instead.
  const belongsToWorkspace =
    input.isScopedListing ||
    withoutTrailingSlash(input.entryCwd) === withoutTrailingSlash(input.workspaceCwd);
  return belongsToWorkspace
    ? { workspaceId: input.workspaceId, crossWorkspace: false }
    : { crossWorkspace: true };
}

export function getSessionTitle(entry: FetchRecentProviderSessionEntry): string {
  const title = entry.title?.trim();
  if (title) {
    return title;
  }
  const firstPromptPreview = entry.firstPromptPreview?.trim();
  if (firstPromptPreview) {
    return firstPromptPreview;
  }
  return i18n.t("importSession.preview.untitledSession");
}

export function getPromptPreview(entry: FetchRecentProviderSessionEntry): string {
  return (
    entry.lastPromptPreview?.trim() ||
    entry.firstPromptPreview?.trim() ||
    i18n.t("importSession.preview.noPrompt")
  );
}

export interface EmptyStateInputs {
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  isQueryingProviders: boolean;
  allQueriesSettled: boolean;
  selectedProvider: string;
  hasQuery: boolean;
  aggregatedCount: number;
  visibleCount: number;
  totalAlreadyImportedCount: number;
  providerLabelById: ReadonlyMap<string, string>;
}

export function computeEmptyState(input: EmptyStateInputs): {
  showEmptyState: boolean;
  emptyStateTitle: string;
} {
  const showEmptyState =
    !input.isLoadingSessions &&
    !input.allQueriesErrored &&
    input.isQueryingProviders &&
    input.allQueriesSettled &&
    input.visibleCount === 0;
  if (!showEmptyState) {
    return { showEmptyState, emptyStateTitle: "" };
  }
  // A query narrowing the list to nothing is a different answer from a host with
  // nothing to import, and the recovery is different too.
  if (input.hasQuery) {
    return { showEmptyState, emptyStateTitle: i18n.t("importSession.empty.noMatches") };
  }
  const isFilteredEmpty = input.selectedProvider !== ALL_FILTER_VALUE && input.aggregatedCount > 0;
  if (isFilteredEmpty) {
    const label = input.providerLabelById.get(input.selectedProvider) ?? input.selectedProvider;
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.noProviderSessions", { provider: label }),
    };
  }
  if (input.totalAlreadyImportedCount > 0) {
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.alreadyImported"),
    };
  }
  return { showEmptyState, emptyStateTitle: i18n.t("importSession.empty.noRecent") };
}
