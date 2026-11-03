/**
 * What this window reports to the desktop main process about what it shows. Pure and
 * deterministic — sorts and dedupes, so two logically-equal inputs always produce two
 * deep-equal outputs regardless of Set iteration order or which publisher last wrote to
 * the store. `use-report-window-view.ts` relies on that to skip sending an unchanged
 * report every time the underlying maps are rebuilt.
 */
export interface WindowViewReport {
  visibleAgentIds: string[];
  visibleWorkspaceKeys: string[];
}

export function buildWindowViewReport(state: {
  visibleAgentIds: readonly string[];
  // `null` means the sidebar isn't actively reporting (inactive, or not mounted yet) —
  // distinct from `[]` ("active, showing nothing"), but both serialize to `[]` on the
  // wire: an inactive sidebar should not claim any workspace.
  visibleWorkspaceKeys: readonly string[] | null;
}): WindowViewReport {
  return {
    visibleAgentIds: dedupeSorted(state.visibleAgentIds),
    visibleWorkspaceKeys: dedupeSorted(state.visibleWorkspaceKeys ?? []),
  };
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
