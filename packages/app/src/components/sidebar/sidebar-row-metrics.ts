import type { Theme } from "@/styles/theme";

/**
 * Vertical density for sidebar project and workspace rows. "Comfortable" is the
 * default; "compact" is the opt-in appearance preference. Defined once here so
 * the row stylesheets consume a single source instead of each hard-coding the
 * same minHeight / paddingVertical literals (and a second compact set).
 */
export interface SidebarRowDensity {
  minHeight: number;
  paddingVertical: number;
}

export function comfortableSidebarRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 36, paddingVertical: theme.spacing[2] };
}

export function compactSidebarRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 28, paddingVertical: theme.spacing[1] };
}

export function comfortableSidebarSecondaryRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 32, paddingVertical: theme.spacing[1] };
}

export function compactSidebarSecondaryRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 24, paddingVertical: theme.spacing[0] };
}
