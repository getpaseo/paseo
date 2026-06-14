import type { ExplorerEntry } from "@/stores/session-store";

export function isHiddenExplorerPath(path: string): boolean {
  return path.split("/").some((segment) => segment !== "." && segment.startsWith("."));
}

export function filterVisibleExplorerEntries(
  entries: ExplorerEntry[],
  hideDotFiles: boolean,
): ExplorerEntry[] {
  if (!hideDotFiles) {
    return entries;
  }
  return entries.filter((entry) => !entry.name.startsWith("."));
}
