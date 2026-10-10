import type { DesktopSettingsStore } from "./desktop-settings.js";

export interface DesktopCommandContext {
  /** webContents id of the renderer that issued `paseo:invoke`. */
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
