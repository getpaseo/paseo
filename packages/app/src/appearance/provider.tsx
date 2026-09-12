import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import { PLUGIN_THEME_NAMES, PLUGIN_THEME_PREFERENCE, THEME_TO_UNISTYLES } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { applyAppearance, type AppearanceInput } from "./apply";

interface ContributedThemes {
  options: PluginThemeOption[];
  selected: PluginThemeOption | null;
  select: (option: PluginThemeOption) => void;
}

interface ApplyThemeInput {
  preference: AppSettings["theme"];
  contributedTheme: PluginThemeOption | null;
}

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

function applyTheme({ preference, contributedTheme }: ApplyThemeInput): void {
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    return;
  }

  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }

  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const options = usePluginThemeCatalog();
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);

  const appearanceInput = useMemo<AppearanceInput>(
    () => ({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
    }),
    [
      settings.codeFontSize,
      settings.contentFontSize,
      settings.monoFontFamily,
      settings.syntaxTheme,
      settings.uiBaseFontSize,
      settings.uiFontFamily,
    ],
  );

  useEffect(() => {
    if (isLoading) return;
    applyTheme({ preference: settings.theme, contributedTheme: selected });
    applyAppearance(appearanceInput);
  }, [appearanceInput, isLoading, selected, settings.theme]);

  // CSS-variable styles repaint from the `prefers-color-scheme` media query alone, but
  // `withUnistyles` mappings (markdown styles, tab scrim colors) only re-read the theme when
  // Unistyles' own matchMedia listeners deliver a change event. A renderer suspended while the
  // OS switches appearance can miss that event: the surrounding chrome turns light while
  // transcript markdown keeps the dark theme's colors until a reload. On regained focus,
  // pageshow, or visibility, re-commit the appearance when the live scheme no longer matches
  // the last one we saw — `applyAppearance` re-emits the theme, so every mapping re-reads the
  // current scheme without waiting for the missed event.
  useEffect(() => {
    if (!isWeb || isLoading) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let lastSeenDark = media.matches;
    const trackScheme = (event: MediaQueryListEvent) => {
      lastSeenDark = event.matches;
    };
    const reconcileSuspendedSchemeChange = () => {
      if (document.hidden || media.matches === lastSeenDark) return;
      lastSeenDark = media.matches;
      applyAppearance(appearanceInput);
    };
    media.addEventListener("change", trackScheme);
    window.addEventListener("focus", reconcileSuspendedSchemeChange);
    window.addEventListener("pageshow", reconcileSuspendedSchemeChange);
    document.addEventListener("visibilitychange", reconcileSuspendedSchemeChange);
    return () => {
      media.removeEventListener("change", trackScheme);
      window.removeEventListener("focus", reconcileSuspendedSchemeChange);
      window.removeEventListener("pageshow", reconcileSuspendedSchemeChange);
      document.removeEventListener("visibilitychange", reconcileSuspendedSchemeChange);
    };
  }, [appearanceInput, isLoading]);

  const select = useCallback(
    (option: PluginThemeOption) => {
      rememberPluginThemeHost(option);
      void updateSettings({
        theme: PLUGIN_THEME_PREFERENCE,
        pluginThemeId: option.id,
      });
    },
    [updateSettings],
  );
  const value = useMemo(() => ({ options, selected, select }), [options, selected, select]);

  return (
    <ContributedThemesContext.Provider value={value}>{children}</ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
