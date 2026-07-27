import { UnistylesRuntime } from "react-native-unistyles";

import { isWeb } from "@/constants/platform";
import { THEME_SURFACE0, THEME_TO_UNISTYLES, type ThemeName } from "./theme";

export type AppThemeSetting = ThemeName | "auto";

export function isAppThemeSetting(value: unknown): value is AppThemeSetting {
  return value === "auto" || (typeof value === "string" && value in THEME_TO_UNISTYLES);
}

function applyWebShellBackground(theme: ThemeName): void {
  if (!isWeb) {
    return;
  }
  try {
    const surface0 = THEME_SURFACE0[theme];
    const root = globalThis.document?.documentElement;
    if (!root) {
      return;
    }
    root.style.backgroundColor = surface0;
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    const bootStyle = globalThis.document?.querySelector("style[data-paseo-boot-theme]");
    if (bootStyle) {
      bootStyle.textContent = `html,body,#root{background-color:${surface0}!important;}`;
    }
    const meta = globalThis.document?.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", surface0);
    }
  } catch {
    // Ignore DOM failures in non-browser test environments.
  }
}

/** Apply a persisted theme setting to Unistyles (adaptive vs named theme). */
export function applyThemeSetting(theme: AppThemeSetting): void {
  if (theme === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }
  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[theme]);
  applyWebShellBackground(theme);
}
