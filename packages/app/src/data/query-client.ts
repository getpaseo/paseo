import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_KEY,
  APP_SETTINGS_QUERY_KEY,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Web: AsyncStorage is Promise-wrapped localStorage, so the settings query is
 * pending for a frame unless we seed the cache synchronously. That frame also
 * drove theme FOUC when React applied DEFAULT theme "auto" over a named pick.
 */
function readSyncAppSettingsFromLocalStorage(): AppSettings | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== "function") {
      return undefined;
    }
    const raw = storage.getItem(APP_SETTINGS_KEY);
    if (!raw) {
      return undefined;
    }
    return normalizeAppSettings(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

const syncHydratedAppSettings = readSyncAppSettingsFromLocalStorage();
if (syncHydratedAppSettings) {
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, syncHydratedAppSettings);
}
