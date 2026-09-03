import type { ClientSettingsDocument, ClientSettingsStore } from "./client-settings.js";
import type { DesktopSettingsStore } from "./desktop-settings.js";
import type { SettingsSeedDocument } from "./settings-seed.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export interface RendererSettingsSeed {
  path: string;
  app: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDesktopSettingsCommandHandlers({
  settingsStore,
  clientSettingsStore,
  loadSettingsSeed,
}: {
  settingsStore: DesktopSettingsStore;
  clientSettingsStore: ClientSettingsStore;
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
    // Same contract as the seed: an unreadable file rejects rather than reporting "no settings",
    // which the renderer would read as an invitation to start over from empty.
    get_client_settings: (): Promise<ClientSettingsDocument | null> => clientSettingsStore.get(),
    set_client_setting: (args): Promise<ClientSettingsDocument> => {
      const field = args?.field;
      if (typeof field !== "string" || field.length === 0) {
        throw new Error("[ClientSettings] set_client_setting requires a field name.");
      }
      return clientSettingsStore.setField(field, args?.value ?? null);
    },
    initialize_client_settings: (args): Promise<ClientSettingsDocument> =>
      clientSettingsStore.initialize(isRecord(args?.entries) ? args.entries : {}),
  };
}
