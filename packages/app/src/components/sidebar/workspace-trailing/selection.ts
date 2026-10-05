import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";

export type SidebarTrailingChoice = "diff" | "timestamp";

interface SidebarTrailingSelection {
  trailing: SidebarWorkspaceTrailing;
  choice: SidebarTrailingChoice;
}

/** Resolve each independent toggle from the persisted trailing preference. */
export function isSidebarTrailingItemEnabled({
  trailing,
  choice,
}: SidebarTrailingSelection): boolean {
  return trailing === "both" || trailing === choice;
}

/** Toggle one item without changing the other or rewriting existing saved preferences. */
export function toggleSidebarTrailingItem({
  trailing,
  choice,
}: SidebarTrailingSelection): SidebarWorkspaceTrailing {
  if (trailing === "both") return choice === "diff" ? "timestamp" : "diff";
  if (trailing === choice) return "none";
  if (trailing === "none") return choice;
  return "both";
}
