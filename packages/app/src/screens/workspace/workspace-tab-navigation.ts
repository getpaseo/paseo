export function getWorkspaceRelativeTabId(
  tabIds: readonly string[],
  activeTabId: string | null,
  delta: 1 | -1,
): string | null {
  if (tabIds.length === 0) return null;
  const currentIndex = tabIds.indexOf(activeTabId ?? "");
  const fromIndex = currentIndex >= 0 ? currentIndex : 0;
  return tabIds[(fromIndex + delta + tabIds.length) % tabIds.length] ?? null;
}
