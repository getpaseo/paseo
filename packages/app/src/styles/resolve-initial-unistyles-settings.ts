import { THEME_TO_UNISTYLES, type ThemeName } from "./theme";

// Keep in sync with APP_SETTINGS_KEY in hooks/use-settings/storage.ts.
const APP_SETTINGS_STORAGE_KEY = "@paseo:app-settings";

type UnistylesThemeKey = (typeof THEME_TO_UNISTYLES)[ThemeName];

export type InitialUnistylesSettings =
  | { adaptiveThemes: true }
  | { initialTheme: UnistylesThemeKey };

function readPersistedThemeName(): ThemeName | "auto" | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== "function") {
      return null;
    }
    const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const theme = (parsed as { theme?: unknown }).theme;
    if (theme === "auto") {
      return "auto";
    }
    if (typeof theme === "string" && theme in THEME_TO_UNISTYLES) {
      return theme as ThemeName;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve Unistyles configure settings synchronously so the first paint uses
 * the persisted theme. `initialTheme` and `adaptiveThemes` are mutually exclusive.
 */
export function resolveInitialUnistylesSettings(): InitialUnistylesSettings {
  const theme = readPersistedThemeName();
  if (!theme || theme === "auto") {
    return { adaptiveThemes: true };
  }
  return { initialTheme: THEME_TO_UNISTYLES[theme] };
}
