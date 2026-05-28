import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CHANGES_PREFERENCES_QUERY_KEY,
  DEFAULT_CHANGES_PREFERENCES,
  loadChangesPreferencesFromStorage as loadChangesPreferencesFromStoragePure,
  saveChangesPreferences as saveChangesPreferencesPure,
  type ChangesPreferences,
  type KeyValueStorage,
} from "./storage";

export { DEFAULT_CHANGES_PREFERENCES, type ChangesPreferences, type KeyValueStorage };

const productionStorage: KeyValueStorage = AsyncStorage;

export function loadChangesPreferencesFromStorage(): Promise<ChangesPreferences> {
  return loadChangesPreferencesFromStoragePure(productionStorage);
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
      await saveChangesPreferencesPure({
        queryClient,
        updates,
        storage: productionStorage,
      });
    },
    [queryClient],
  );

  return {
    preferences: data ?? DEFAULT_CHANGES_PREFERENCES,
    isLoading: isPending,
    updatePreferences,
  };
}
