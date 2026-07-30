import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BACKLOG_PREFERENCES_QUERY_KEY,
  DEFAULT_BACKLOG_PREFERENCES,
  loadBacklogPreferencesFromStorage as loadBacklogPreferencesFromStoragePure,
  resolveBacklogViewMode,
  saveBacklogPreferences as saveBacklogPreferencesPure,
  type BacklogPreferences,
  type BacklogViewModePreference,
  type KeyValueStorage,
} from "./storage";

export {
  DEFAULT_BACKLOG_PREFERENCES,
  resolveBacklogViewMode,
  type BacklogPreferences,
  type BacklogViewModePreference,
  type KeyValueStorage,
};

const productionStorage: KeyValueStorage = AsyncStorage;

export function loadBacklogPreferencesFromStorage(): Promise<BacklogPreferences> {
  return loadBacklogPreferencesFromStoragePure(productionStorage);
}

export interface UseBacklogPreferencesReturn {
  preferences: BacklogPreferences;
  isLoading: boolean;
  updatePreferences: (updates: Partial<BacklogPreferences>) => Promise<void>;
}

export function useBacklogPreferences(): UseBacklogPreferencesReturn {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: BACKLOG_PREFERENCES_QUERY_KEY,
    queryFn: loadBacklogPreferencesFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updatePreferences = useCallback(
    async (updates: Partial<BacklogPreferences>) => {
      await saveBacklogPreferencesPure({
        queryClient,
        updates,
        storage: productionStorage,
      });
    },
    [queryClient],
  );

  return {
    preferences: data ?? DEFAULT_BACKLOG_PREFERENCES,
    isLoading: isPending,
    updatePreferences,
  };
}
