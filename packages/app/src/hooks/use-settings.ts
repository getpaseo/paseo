import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const APP_SETTINGS_KEY = "@paseo:app-settings";
const LEGACY_SETTINGS_KEY = "@paseo:settings";
const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export interface AppSettings {
  theme: "dark" | "light" | "auto" | "colorblind";
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
};

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
        const prev = queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? DEFAULT_APP_SETTINGS;
        const next = { ...prev, ...updates };
        queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
        await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
      } catch (err) {
        console.error("[AppSettings] Failed to save settings:", err);
        throw err;
      }
    },
    [queryClient]
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

async function loadSettingsFromStorage(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AppSettings>;
      return { ...DEFAULT_APP_SETTINGS, ...parsed };
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
  if (
    legacy.theme === "dark" ||
    legacy.theme === "light" ||
    legacy.theme === "auto" ||
    legacy.theme === "colorblind"
  ) {
    result.theme = legacy.theme;
  }
  return result;
}

export const useSettings = useAppSettings;
