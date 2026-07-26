import AsyncStorage from "@react-native-async-storage/async-storage";

import { isElectronRuntime } from "@/desktop/host";
import {
  loadDesktopSettings,
  updatePersistedDesktopSettings,
} from "@/desktop/settings/desktop-settings";
import type { PortableConfigDeps } from "./portable-config";

export const portableConfigRuntimeDeps: PortableConfigDeps = {
  storage: AsyncStorage,
  isDesktop: isElectronRuntime,
  loadDesktopSettings,
  updateDesktopSettings: updatePersistedDesktopSettings,
  now: () => new Date().toISOString(),
};
