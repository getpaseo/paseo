import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

const CHANGES_PREFERENCES_STORAGE_KEY = "@paseo:changes-preferences";
const LEGACY_WRAP_LINES_STORAGE_KEY = "diff-wrap-lines";
const CHANGES_PREFERENCES_QUERY_KEY = ["changes-preferences"];

const changesPreferencesSchema = z.object({
  layout: z.enum(["unified", "split"]).optional(),
  wrapLines: z.boolean().optional(),
  hideWhitespace: z.boolean().optional(),
});

export interface ChangesPreferences {
  layout: "unified" | "split";
  wrapLines: boolean;
  hideWhitespace: boolean;
}

export const DEFAULT_CHANGES_PREFERENCES: ChangesPreferences = {
  layout: "unified",
  wrapLines: false,
  hideWhitespace: false,
};

async function loadLegacyWrapLinesPreference(): Promise<boolean | null> {
  const legacyValue = await AsyncStorage.getItem(LEGACY_WRAP_LINES_STORAGE_KEY);
  if (legacyValue === "true") {
    return true;
  }
  if (legacyValue === "false") {
    return false;
  }
  return null;
}

export async function loadChangesPreferencesFromStorage(): Promise<ChangesPreferences> {
  const stored = await AsyncStorage.getItem(CHANGES_PREFERENCES_STORAGE_KEY);
  if (stored) {
    const parsed = changesPreferencesSchema.safeParse(JSON.parse(stored));
    if (parsed.success) {
      return { ...DEFAULT_CHANGES_PREFERENCES, ...parsed.data };
    }
  }

  const legacyWrapLines = await loadLegacyWrapLinesPreference();
  const next = {
    ...DEFAULT_CHANGES_PREFERENCES,
    ...(legacyWrapLines !== null ? { wrapLines: legacyWrapLines } : {}),
  } satisfies ChangesPreferences;
  await AsyncStorage.setItem(CHANGES_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export interface UseChangesPreferencesReturn {
  preferences: ChangesPreferences;
  isLoading: boolean;
  updatePreferences: (updates: Partial<ChangesPreferences>) => Promise<void>;
}

export function useChangesPreferences(): UseChangesPreferencesReturn {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: CHANGES_PREFERENCES_QUERY_KEY,
    queryFn: loadChangesPreferencesFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updatePreferences = useCallback(
    async (updates: Partial<ChangesPreferences>) => {
      const prev =
        queryClient.getQueryData<ChangesPreferences>(CHANGES_PREFERENCES_QUERY_KEY) ??
        DEFAULT_CHANGES_PREFERENCES;
      const next = { ...prev, ...updates };
      queryClient.setQueryData<ChangesPreferences>(CHANGES_PREFERENCES_QUERY_KEY, next);
      await AsyncStorage.setItem(CHANGES_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
    },
    [queryClient],
  );

  return {
    preferences: data ?? DEFAULT_CHANGES_PREFERENCES,
    isLoading: isPending,
    updatePreferences,
  };
}
