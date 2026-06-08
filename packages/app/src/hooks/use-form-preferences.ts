import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildFavoriteModelKey,
  DEFAULT_FORM_PREFERENCES,
  isFavoriteModel,
  mergeProviderPreferences,
  toggleFavoriteModel,
  type FavoriteModelPreference,
  type FavoriteModelRow,
  type FormPreferences,
  type ProviderPreferences,
} from "@/create-agent-preferences/preferences";
import {
  createAgentPreferencesService,
  type FormPreferenceUpdate,
} from "@/create-agent-preferences/service";

const FORM_PREFERENCES_QUERY_KEY = ["form-preferences"];

export type { FavoriteModelPreference, FavoriteModelRow, FormPreferences, ProviderPreferences };

export { buildFavoriteModelKey, isFavoriteModel, mergeProviderPreferences, toggleFavoriteModel };

async function loadFormPreferences(): Promise<FormPreferences> {
  return createAgentPreferencesService.load();
}

export interface UseFormPreferencesReturn {
  preferences: FormPreferences;
  isLoading: boolean;
  updatePreferences: (updates: FormPreferenceUpdate) => Promise<void>;
}

export function useFormPreferences(): UseFormPreferencesReturn {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: FORM_PREFERENCES_QUERY_KEY,
    queryFn: loadFormPreferences,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const preferences = data ?? DEFAULT_FORM_PREFERENCES;

  const updatePreferences = useCallback(
    async (updates: FormPreferenceUpdate) => {
      const next = await createAgentPreferencesService.update(updates);
      queryClient.setQueryData<FormPreferences>(FORM_PREFERENCES_QUERY_KEY, next);
    },
    [queryClient],
  );

  return {
    preferences,
    isLoading: isPending,
    updatePreferences,
  };
}
