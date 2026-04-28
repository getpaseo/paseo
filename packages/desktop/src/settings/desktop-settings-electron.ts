import { app } from "electron";

import { createDesktopSettingsStore, type DesktopSettingsStore } from "./desktop-settings.js";

let desktopSettingsStore: DesktopSettingsStore | null = null;

export function getDesktopSettingsStore(): DesktopSettingsStore {
  desktopSettingsStore ??= createDesktopSettingsStore({
    userDataPath: app.getPath("userData"),
  });
  return desktopSettingsStore;
}
