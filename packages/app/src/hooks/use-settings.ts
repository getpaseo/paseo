import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const APP_SETTINGS_KEY = "@paseo:app-settings";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export interface AppSettings {
  theme: "dark" | "light" | "auto";
  manageBuiltInDaemon: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "auto",
  manageBuiltInDaemon: true,
};

function normalizeTheme(value: unknown): AppSettings["theme"] {
  if (value === "dark" || value === "light" || value === "auto") {
    return value;
  }
  return DEFAULT_APP_SETTINGS.theme;
}

function sanitizeAppSettings(input: Record<string, unknown>): {
  settings: AppSettings;
  changed: boolean;
} {
  const normalizedTheme = normalizeTheme(input.theme);
  const normalizedManageBuiltInDaemon =
    typeof input.manageBuiltInDaemon === "boolean"
      ? input.manageBuiltInDaemon
      : DEFAULT_APP_SETTINGS.manageBuiltInDaemon;

  const settings: AppSettings = {
    theme: normalizedTheme,
    manageBuiltInDaemon: normalizedManageBuiltInDaemon,
  };

  const changed =
    input.theme !== undefined
      ? input.theme !== normalizedTheme || typeof input.manageBuiltInDaemon !== "boolean"
      : typeof input.manageBuiltInDaemon !== "boolean" && input.manageBuiltInDaemon !== undefined;

  return { settings, changed };
}

export interface UseAppSettingsReturn {
  settings: AppSettings;
  isLoading: boolean;
  error: unknown | null;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export function useAppSettings(): UseAppSettingsReturn {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: loadSettingsFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updateSettings = useCallback(
    async (updates: Partial<AppSettings>) => {
      try {
        const prev =
          queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? DEFAULT_APP_SETTINGS;
        const { settings: next } = sanitizeAppSettings({ ...prev, ...updates });
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
      const next = { ...DEFAULT_APP_SETTINGS };
      queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
      await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
    } catch (err) {
      console.error("[AppSettings] Failed to reset settings:", err);
      throw err;
    }
  }, [queryClient]);

  return {
    settings: data ?? DEFAULT_APP_SETTINGS,
    isLoading: isPending,
    error: error ?? null,
    updateSettings,
    resetSettings,
  };
}

export async function loadSettingsFromStorage(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      const { settings, changed } = sanitizeAppSettings(parsed);
      if (changed) {
        await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
      }
      return settings;
    }

    const legacyStored = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacyStored) {
      const legacyParsed = JSON.parse(legacyStored) as Record<string, unknown>;
      const next = {
        ...DEFAULT_APP_SETTINGS,
        ...pickAppSettingsFromLegacy(legacyParsed),
      } satisfies AppSettings;
      await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
      return next;
    }

    await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS));
    return DEFAULT_APP_SETTINGS;
  } catch (error) {
    console.error("[AppSettings] Failed to load settings:", error);
    throw error;
  }
}

function pickAppSettingsFromLegacy(legacy: Record<string, unknown>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light" || legacy.theme === "auto") {
    result.theme = legacy.theme;
  }
  if (typeof legacy.manageBuiltInDaemon === "boolean") {
    result.manageBuiltInDaemon = legacy.manageBuiltInDaemon;
  }
  return result;
}

export const useSettings = useAppSettings;
