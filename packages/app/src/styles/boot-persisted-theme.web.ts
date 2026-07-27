import { applyThemeSetting, isAppThemeSetting } from "./apply-theme-setting";

// Keep in sync with APP_SETTINGS_KEY in hooks/use-settings/storage.ts.
// Inline the key so theme boot does not pull the settings module graph into unistyles init.
const APP_SETTINGS_STORAGE_KEY = "@paseo:app-settings";

/**
 * Synchronously apply the persisted theme before React paints.
 * Web AsyncStorage is Promise-wrapped localStorage, so the React settings path
 * always yields at least one wrong-theme frame without this boot.
 *
 * Must run after `StyleSheet.configure` (see unistyles.ts).
 */
export function bootPersistedThemeFromStorage(): void {
  try {
    const raw = globalThis.localStorage?.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const theme = (parsed as { theme?: unknown }).theme;
    if (!isAppThemeSetting(theme)) {
      return;
    }
    applyThemeSetting(theme);
  } catch {
    // Ignore corrupt settings; React settings load will apply defaults.
  }
}
