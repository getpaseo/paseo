import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const STORAGE_KEY = "@paseo:keyboard-shortcut-overrides";
const QUERY_KEY = ["keyboard-shortcut-overrides"];

const EMPTY_OVERRIDES: Record<string, string> = {};

export interface UseKeyboardShortcutOverridesReturn {
  overrides: Record<string, string>;
  isLoading: boolean;
  setOverride: (bindingId: string, comboString: string) => Promise<void>;
  removeOverride: (bindingId: string) => Promise<void>;
  resetAll: () => Promise<void>;
  hasOverrides: boolean;
}

export function useKeyboardShortcutOverrides(): UseKeyboardShortcutOverridesReturn {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: loadOverridesFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setOverride = useCallback(
    async (bindingId: string, comboString: string) => {
      const prev = queryClient.getQueryData<Record<string, string>>(QUERY_KEY) ?? EMPTY_OVERRIDES;
      const next = { ...prev, [bindingId]: comboString };
      queryClient.setQueryData<Record<string, string>>(QUERY_KEY, next);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [queryClient],
  );

  const removeOverride = useCallback(
    async (bindingId: string) => {
      const prev = queryClient.getQueryData<Record<string, string>>(QUERY_KEY) ?? EMPTY_OVERRIDES;
      const { [bindingId]: _, ...next } = prev;
      queryClient.setQueryData<Record<string, string>>(QUERY_KEY, next);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [queryClient],
  );

  const resetAll = useCallback(async () => {
    queryClient.setQueryData<Record<string, string>>(QUERY_KEY, EMPTY_OVERRIDES);
    await AsyncStorage.removeItem(STORAGE_KEY);
  }, [queryClient]);

  const overrides = data ?? EMPTY_OVERRIDES;

  return {
    overrides,
    isLoading: isPending,
    setOverride,
    removeOverride,
    resetAll,
    hasOverrides: Object.keys(overrides).length > 0,
  };
}

async function loadOverridesFromStorage(): Promise<Record<string, string>> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as Record<string, string>;
    }
  } catch (err) {
    console.error("[KeyboardShortcutOverrides] Failed to load overrides:", err);
  }
  return EMPTY_OVERRIDES;
}
