import type { DesktopSettingsStore } from "./desktop-settings.js";

// Identifies the renderer that sent a command, so a command can be scoped to
// the window that issued it.
export interface DesktopCommandContext {
  senderId: number;
}

export type DesktopCommandHandler = (
  args?: Record<string, unknown>,
  context?: DesktopCommandContext,
) => unknown;

export function createDesktopSettingsCommandHandlers({
  settingsStore,
}: {
  settingsStore: DesktopSettingsStore;
}): Record<string, DesktopCommandHandler> {
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: (args) => settingsStore.patch(args),
    migrate_legacy_desktop_settings: (args) => settingsStore.migrateLegacyRendererSettings(args),
  };
}
