import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import type { DesktopSettingsBridge, KeyValueStorage, ReleaseChannel } from "./storage";

export interface InMemoryKeyValueStorage extends KeyValueStorage {
  readonly entries: Map<string, string>;
}

export function createInMemoryKeyValueStorage(
  initial: Record<string, string> = {},
): InMemoryKeyValueStorage {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    async getItem(key) {
      return entries.get(key) ?? null;
    },
    async setItem(key, value) {
      entries.set(key, value);
    },
    async removeItem(key) {
      entries.delete(key);
    },
  };
}

export interface FakeDesktopBridge extends DesktopSettingsBridge {
  readonly migrationsApplied: Array<{
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  }>;
}

const DEFAULT_DESKTOP: DesktopSettings = {
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  power: {
    keepAwakeWhileAgentsRunning: false,
  },
};

export function createFakeDesktopBridge(
  options: {
    isElectron?: boolean;
    settings?: DesktopSettings;
  } = {},
): FakeDesktopBridge {
  const isElectron = options.isElectron ?? false;
  const settings = options.settings ?? DEFAULT_DESKTOP;
  const migrationsApplied: FakeDesktopBridge["migrationsApplied"] = [];
  return {
    migrationsApplied,
    isElectron: () => isElectron,
    async loadDesktopSettings() {
      return settings;
    },
    async migrateLegacyDesktopSettings(input) {
      migrationsApplied.push(input);
    },
  };
}
