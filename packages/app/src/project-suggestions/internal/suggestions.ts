import type { ProjectSuggestion } from "@getpaseo/protocol/messages";

export type { ProjectSuggestion };

const PRESELECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PRESELECT_MIN_SESSIONS = 3;

/** One provider's answer. Each provider is asked separately so a slow one never holds up the rest. */
export type ProviderSuggestions =
  | { provider: string; label: string; status: "loading" }
  | { provider: string; label: string; status: "ready"; suggestions: ProjectSuggestion[] }
  | {
      provider: string;
      label: string;
      status: "failed";
      message: string;
      suggestions: ProjectSuggestion[];
    };

/** Combines the providers that answered into one row per folder, most recent first. */
export function mergeProviderSuggestions(
  providers: readonly ProviderSuggestions[],
  addedRootPaths: ReadonlySet<string>,
): ProjectSuggestion[] {
  const byRoot = new Map<string, ProjectSuggestion>();
  for (const provider of providers) {
    if (provider.status === "loading") continue;
    for (const suggestion of provider.suggestions) {
      if (addedRootPaths.has(suggestion.rootPath)) continue;
      const existing = byRoot.get(suggestion.rootPath);
      byRoot.set(
        suggestion.rootPath,
        existing ? combineSuggestions(existing, suggestion) : suggestion,
      );
    }
  }
  return Array.from(byRoot.values()).sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
}

function combineSuggestions(a: ProjectSuggestion, b: ProjectSuggestion): ProjectSuggestion {
  return {
    ...a,
    sessionCount: a.sessionCount + b.sessionCount,
    providerIds: Array.from(new Set([...a.providerIds, ...b.providerIds])).sort(),
    lastActivityAt: a.lastActivityAt > b.lastActivityAt ? a.lastActivityAt : b.lastActivityAt,
  };
}

/**
 * True until the first provider answers. After that the list shows what it has, including a failed
 * provider's Retry, while the slower providers keep reading.
 */
export function isAwaitingFirstAnswer(providers: readonly ProviderSuggestions[]): boolean {
  return providers.length > 0 && providers.every((provider) => provider.status === "loading");
}

/** Folders the user worked in often and recently start checked. */
export function isPreselected(suggestion: ProjectSuggestion, now: Date): boolean {
  return (
    suggestion.sessionCount >= PRESELECT_MIN_SESSIONS &&
    now.getTime() - Date.parse(suggestion.lastActivityAt) <= PRESELECT_WINDOW_MS
  );
}

/**
 * Checks start from the preselection; once the user toggles a row, their choice sticks even as
 * more providers answer and the row's counts change.
 */
export function isSuggestionChecked(
  suggestion: ProjectSuggestion,
  choices: Readonly<Record<string, boolean>>,
  now: Date,
): boolean {
  return choices[suggestion.rootPath] ?? isPreselected(suggestion, now);
}

/**
 * Adds each folder in turn and returns the ones that failed, with the host's message when it gave
 * one. Sequential so the sidebar fills in the order the user sees.
 */
export async function addSuggestedProjects(
  rootPaths: readonly string[],
  addProject: (rootPath: string) => Promise<{ ok: true } | { ok: false; error: string | null }>,
): Promise<Map<string, string | null>> {
  const failures = new Map<string, string | null>();
  for (const rootPath of rootPaths) {
    try {
      const result = await addProject(rootPath);
      if (!result.ok) failures.set(rootPath, result.error);
    } catch (error) {
      failures.set(rootPath, error instanceof Error ? error.message : null);
    }
  }
  return failures;
}
