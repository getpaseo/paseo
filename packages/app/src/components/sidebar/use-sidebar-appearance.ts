import { useAppSettings, type AppearanceSettings } from "@/hooks/use-settings";

/**
 * Sidebar appearance preferences (device-local). Returns a stable, fully
 * defaulted shape so callers read clean booleans without `??` fallbacks. Backed
 * by the low-frequency app-settings query, so calling it per row surface is
 * cheap and matches how the sidebar already reads settings.
 */
export function useSidebarAppearance(): AppearanceSettings {
  return useAppSettings().settings.appearance;
}
