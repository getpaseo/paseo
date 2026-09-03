import { app } from "electron";

import { type ClientSettingsStore, createClientSettingsStore } from "./client-settings.js";
import { createDesktopSettingsStore, type DesktopSettingsStore } from "./desktop-settings.js";
import { loadSettingsSeed, type SettingsSeedDocument } from "./settings-seed.js";

let desktopSettingsStore: DesktopSettingsStore | null = null;
let clientSettingsStore: ClientSettingsStore | null = null;

export function getDesktopSettingsStore(): DesktopSettingsStore {
  desktopSettingsStore ??= createDesktopSettingsStore({
    userDataPath: app.getPath("userData"),
    loadSeed: loadDesktopSettingsSeed,
  });
  return desktopSettingsStore;
}

/** One store per process so every window's writes queue behind each other. */
export function getClientSettingsStore(): ClientSettingsStore {
  clientSettingsStore ??= createClientSettingsStore({
    userDataPath: app.getPath("userData"),
  });
  return clientSettingsStore;
}

export function loadDesktopSettingsSeed(): Promise<SettingsSeedDocument | null> {
  return loadSettingsSeed({ userDataPath: app.getPath("userData") });
}
