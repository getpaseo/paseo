import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/query/query-client";
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  migrateLegacyDesktopSettings,
  useDesktopSettings,
} from "@/desktop/settings/desktop-settings";
import { isElectronRuntime } from "@/desktop/host";
import {
  APP_SETTINGS_KEY,
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  loadAppSettingsFromStorage as loadAppSettingsFromStoragePure,
  loadSettingsFromStorage as loadSettingsFromStoragePure,
  parseTerminalScrollbackLines,
  saveAppSettings as saveAppSettingsPure,
  type AppSettings,
  type DesktopSettingsBridge,
  type KeyValueStorage,
  type ReleaseChannel,
  type SendBehavior,
  type ServiceUrlBehavior,
  type Settings,
  type SettingsDeps,
} from "./storage";

export {
  APP_SETTINGS_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  parseTerminalScrollbackLines,
};
export type {
  AppSettings,
  DesktopSettingsBridge,
  KeyValueStorage,
  ReleaseChannel,
  SendBehavior,
  ServiceUrlBehavior,
  Settings,
  SettingsDeps,
};

const productionDeps: SettingsDeps = {
  storage: AsyncStorage,
  desktop: {
    isElectron: isElectronRuntime,
    loadDesktopSettings,
    migrateLegacyDesktopSettings,
  },
};

export interface UseAppSettingsReturn {
  settings: AppSettings;
  isLoading: boolean;
  error: unknown;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export interface UseSettingsReturn {
  settings: Settings;
  isLoading: boolean;
  error: unknown;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export function useAppSettings(): UseAppSettingsReturn {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: () => loadAppSettingsFromStorage(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updateSettings = useCallback(
    async (updates: Partial<AppSettings>) => {
      try {
        await saveAppSettings({ queryClient, updates });
      } catch (err) {
        console.error("[AppSettings] Failed to save settings:", err);
        throw err;
      }
    },
    [queryClient],
  );

  const resetSettings = useCallback(async () => {
    try {
      const next = { ...DEFAULT_CLIENT_SETTINGS };
      queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
      await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
    } catch (err) {
      console.error("[AppSettings] Failed to reset settings:", err);
      throw err;
    }
  }, [queryClient]);

  return {
    settings: data ?? DEFAULT_CLIENT_SETTINGS,
    isLoading: isPending,
    error: error ?? null,
    updateSettings,
    resetSettings,
  };
}

export function useSettings(): UseSettingsReturn {
  const appSettings = useAppSettings();
  const desktopSettings = useDesktopSettings();

  const updateSettings = useCallback(
    async (updates: Partial<Settings>) => {
      const appUpdates: Partial<AppSettings> = {};
      if (updates.theme !== undefined) {
        appUpdates.theme = updates.theme;
      }
      if (updates.sendBehavior !== undefined) {
        appUpdates.sendBehavior = updates.sendBehavior;
      }
      if (updates.serviceUrlBehavior !== undefined) {
        appUpdates.serviceUrlBehavior = updates.serviceUrlBehavior;
      }
      if (updates.terminalScrollbackLines !== undefined) {
        appUpdates.terminalScrollbackLines = updates.terminalScrollbackLines;
      }
      const promises: Promise<void>[] = [];
      if (Object.keys(appUpdates).length > 0) {
        promises.push(appSettings.updateSettings(appUpdates));
      }

      if (isElectronRuntime()) {
        const desktopUpdates: Parameters<typeof desktopSettings.updateSettings>[0] = {};
        if (updates.manageBuiltInDaemon !== undefined) {
          desktopUpdates.daemon = {
            manageBuiltInDaemon: updates.manageBuiltInDaemon,
          };
        }
        if (updates.releaseChannel !== undefined) {
          desktopUpdates.releaseChannel = updates.releaseChannel;
        }
        if (Object.keys(desktopUpdates).length > 0) {
          promises.push(desktopSettings.updateSettings(desktopUpdates));
        }
      }

      await Promise.all(promises);
    },
    [appSettings, desktopSettings],
  );

  const resetSettings = useCallback(async () => {
    const resets: Promise<void>[] = [appSettings.resetSettings()];
    if (isElectronRuntime()) {
      resets.push(desktopSettings.updateSettings(DEFAULT_DESKTOP_SETTINGS));
    }
    await Promise.all(resets);
  }, [appSettings, desktopSettings]);

  return {
    settings: {
      ...DEFAULT_APP_SETTINGS,
      ...appSettings.settings,
      manageBuiltInDaemon: desktopSettings.settings.daemon.manageBuiltInDaemon,
      releaseChannel: desktopSettings.settings.releaseChannel,
    },
    isLoading: appSettings.isLoading || desktopSettings.isLoading,
    error: appSettings.error ?? desktopSettings.error,
    updateSettings,
    resetSettings,
  };
}

export async function persistAppSettings(updates: Partial<AppSettings>): Promise<void> {
  await saveAppSettings({ queryClient: appQueryClient, updates });
}

export async function saveAppSettings(input: {
  queryClient: QueryClient;
  updates: Partial<AppSettings>;
  deps?: SettingsDeps;
}): Promise<void> {
  await saveAppSettingsPure({
    queryClient: input.queryClient,
    updates: input.updates,
    deps: input.deps ?? productionDeps,
  });
}

export async function loadAppSettingsFromStorage(deps?: SettingsDeps): Promise<AppSettings> {
  return loadAppSettingsFromStoragePure(deps ?? productionDeps);
}

export async function loadSettingsFromStorage(deps?: SettingsDeps): Promise<Settings> {
  return loadSettingsFromStoragePure(deps ?? productionDeps);
}
