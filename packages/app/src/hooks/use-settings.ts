import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "@/query/query-client";
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  migrateLegacyDesktopSettings,
  useDesktopSettings,
} from "@/desktop/settings/desktop-settings";
import { isElectronRuntime } from "@/desktop/host";
import { THEME_TO_UNISTYLES, type ThemeName } from "@/styles/theme";

export const APP_SETTINGS_KEY = "@paseo:app-settings";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export type SendBehavior = "interrupt" | "queue";
export type ReleaseChannel = "stable" | "beta";
export type ServiceUrlBehavior = "ask" | "in-app" | "external";

const VALID_THEMES = new Set<string>([...Object.keys(THEME_TO_UNISTYLES), "auto"]);
const VALID_SERVICE_URL_BEHAVIORS = new Set<ServiceUrlBehavior>(["ask", "in-app", "external"]);

export interface AppSettings {
  theme: ThemeName | "auto";
  sendBehavior: SendBehavior;
  serviceUrlBehavior: ServiceUrlBehavior;
}

export interface Settings extends AppSettings {
  manageBuiltInDaemon: boolean;
  releaseChannel: ReleaseChannel;
}

export const DEFAULT_CLIENT_SETTINGS: AppSettings = {
  theme: "auto",
  sendBehavior: "interrupt",
  serviceUrlBehavior: "ask",
};

export const DEFAULT_APP_SETTINGS: Settings = {
  ...DEFAULT_CLIENT_SETTINGS,
  manageBuiltInDaemon: true,
  releaseChannel: "stable",
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
    queryFn: loadAppSettingsFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updateSettings = useCallback(
    async (updates: Partial<AppSettings>) => {
      try {
        const prev =
          queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? DEFAULT_CLIENT_SETTINGS;
        const next = { ...prev, ...updates };
        queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
        await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
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
  const current =
    appQueryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage());
  const next = { ...current, ...updates };
  appQueryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
}

export async function loadAppSettingsFromStorage(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>;
      return { ...DEFAULT_CLIENT_SETTINGS, ...pickAppSettings(parsed) };
    }

    const legacyStored = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacyStored) {
      const legacyParsed = JSON.parse(legacyStored) as Record<string, unknown>;
      const next = {
        ...DEFAULT_CLIENT_SETTINGS,
        ...pickAppSettingsFromLegacy(legacyParsed),
      } satisfies AppSettings;
      await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
      return next;
    }

    await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(DEFAULT_CLIENT_SETTINGS));
    return DEFAULT_CLIENT_SETTINGS;
  } catch (error) {
    console.error("[AppSettings] Failed to load settings:", error);
    throw error;
  }
}

export async function loadSettingsFromStorage(): Promise<Settings> {
  const legacyDesktopSettings = isElectronRuntime()
    ? await loadLegacyDesktopSettingsFromStorage()
    : null;
  const appSettings = await loadAppSettingsFromStorage();

  if (!isElectronRuntime()) {
    return {
      ...DEFAULT_APP_SETTINGS,
      ...appSettings,
    };
  }

  if (legacyDesktopSettings) {
    await migrateLegacyDesktopSettings(legacyDesktopSettings);
  }

  const desktopSettings = await loadDesktopSettings();
  return {
    ...DEFAULT_APP_SETTINGS,
    ...appSettings,
    manageBuiltInDaemon: desktopSettings.daemon.manageBuiltInDaemon,
    releaseChannel: desktopSettings.releaseChannel,
  };
}

function pickAppSettings(stored: Partial<AppSettings>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (typeof stored.theme === "string" && VALID_THEMES.has(stored.theme)) {
    result.theme = stored.theme;
  }
  if (stored.sendBehavior === "interrupt" || stored.sendBehavior === "queue") {
    result.sendBehavior = stored.sendBehavior;
  }
  if (
    typeof stored.serviceUrlBehavior === "string" &&
    VALID_SERVICE_URL_BEHAVIORS.has(stored.serviceUrlBehavior)
  ) {
    result.serviceUrlBehavior = stored.serviceUrlBehavior;
  }
  return result;
}

function pickAppSettingsFromLegacy(legacy: Record<string, unknown>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light" || legacy.theme === "auto") {
    result.theme = legacy.theme;
  }
  return result;
}

async function loadLegacyDesktopSettingsFromStorage(): Promise<{
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
} | null> {
  const stored = await loadRendererSettingsPayload();
  if (!stored) {
    return null;
  }

  const result: {
    manageBuiltInDaemon?: boolean;
    releaseChannel?: ReleaseChannel;
  } = {};

  if (typeof stored.manageBuiltInDaemon === "boolean") {
    result.manageBuiltInDaemon = stored.manageBuiltInDaemon;
  }
  if (stored.releaseChannel === "stable" || stored.releaseChannel === "beta") {
    result.releaseChannel = stored.releaseChannel;
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function loadRendererSettingsPayload(): Promise<Record<string, unknown> | null> {
  const current = await AsyncStorage.getItem(APP_SETTINGS_KEY);
  if (current) {
    return JSON.parse(current) as Record<string, unknown>;
  }

  const legacy = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
  if (!legacy) {
    return null;
  }
  return JSON.parse(legacy) as Record<string, unknown>;
}
