import type { IpcMainInvokeEvent } from "electron";
import type { DesktopSettingsStore } from "./desktop-settings.js";

export type DesktopCommandHandler = (
  args?: Record<string, unknown>,
  event?: IpcMainInvokeEvent,
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
