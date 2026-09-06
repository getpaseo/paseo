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

interface SidebarDensityInput {
  compact: boolean;
  spacing: { 1: number; 2: number };
}

export function resolveSidebarRowDensity({
  compact,
  spacing,
}: SidebarDensityInput): SidebarRowDensity {
  return compact
    ? { minHeight: 28, paddingVertical: spacing[1] }
    : { minHeight: 36, paddingVertical: spacing[2] };
}

export function comfortableSidebarRowDensity(theme: Theme): Record<string, number> {
  return { ...resolveSidebarRowDensity({ compact: false, spacing: theme.spacing }) };
}

export function compactSidebarRowDensity(theme: Theme): SidebarRowDensity {
  return resolveSidebarRowDensity({ compact: true, spacing: theme.spacing });
}

export function comfortableSidebarSecondaryRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 32, paddingVertical: theme.spacing[1] };
}

export function compactSidebarSecondaryRowDensity(theme: Theme): SidebarRowDensity {
  return { minHeight: 24, paddingVertical: theme.spacing[0] };
}
