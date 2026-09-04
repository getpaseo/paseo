import type { DesktopSettingsStore } from "./desktop-settings.js";
import type { SettingsSeedDocument } from "./settings-seed.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export interface RendererSettingsSeed {
  path: string;
  app: Record<string, unknown>;
}

export function createDesktopSettingsCommandHandlers({
  settingsStore,
  loadSettingsSeed,
}: {
  settingsStore: DesktopSettingsStore;
  loadSettingsSeed: () => Promise<SettingsSeedDocument | null>;
}): Record<string, DesktopCommandHandler> {
  return {
    get_desktop_settings: () => settingsStore.get(),
    patch_desktop_settings: (args) => settingsStore.patch(args),
    migrate_legacy_desktop_settings: (args) => settingsStore.migrateLegacyRendererSettings(args),
    // A malformed seed rejects the invoke; the renderer surfaces the error
    // instead of silently running on settings the seed was supposed to supply.
    get_settings_seed: async (): Promise<RendererSettingsSeed | null> => {
      const seed = await loadSettingsSeed();
      return seed ? { path: seed.path, app: seed.app } : null;
    },
  };
}
