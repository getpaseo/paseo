import { app } from "electron";

import { createDesktopSettingsStore, type DesktopSettingsStore } from "./desktop-settings.js";
import { loadSettingsSeed, type SettingsSeedDocument } from "./settings-seed.js";

let desktopSettingsStore: DesktopSettingsStore | null = null;

export function getDesktopSettingsStore(): DesktopSettingsStore {
  desktopSettingsStore ??= createDesktopSettingsStore({
    userDataPath: app.getPath("userData"),
  });
  return desktopSettingsStore;
}

export function loadDesktopSettingsSeed(): Promise<SettingsSeedDocument | null> {
  return loadSettingsSeed({ userDataPath: app.getPath("userData") });
}
