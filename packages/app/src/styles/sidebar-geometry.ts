import type { Theme } from "@/styles/theme";

/** Shared by grouped, ungrouped and pinned rows, including their empty-state action. */
export function createSidebarRowGeometry(theme: Theme, kind: "projectRow" | "workspaceRow") {
  const appearance = theme.components.sidebar[kind];
  const minHeight = appearance?.minHeight ?? 36;
  return {
    minHeight: { xs: Math.max(44, minHeight), md: minHeight },
    paddingVertical: appearance?.paddingVertical ?? theme.spacing[2],
    paddingLeft: appearance?.paddingHorizontal ?? theme.spacing[2],
    paddingRight:
      appearance?.paddingHorizontal ??
      (kind === "projectRow" ? theme.spacing[2] : theme.spacing[3]),
    borderRadius: appearance?.radius ?? theme.borderRadius.lg,
  };
}
