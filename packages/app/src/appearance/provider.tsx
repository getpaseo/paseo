import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { SystemBars } from "react-native-edge-to-edge";
import { UnistylesRuntime } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import {
  PLUGIN_THEME_NAMES,
  PLUGIN_THEME_PREFERENCE,
  REGISTERED_THEMES,
  THEME_TO_UNISTYLES,
} from "@/styles/theme";
import { applyAppearance } from "./apply";

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

// Edge-to-edge draws the app under the Android system bars, and the bars keep
// their default light icon style unless told otherwise — invisible on light
// backgrounds (status bar clock/battery unreadable). Track the app theme.
function applySystemBarStyle(colorScheme: "light" | "dark" | "auto"): void {
  if (colorScheme === "auto") {
    SystemBars.setStyle("auto");
    return;
  }
  SystemBars.setStyle(colorScheme === "dark" ? "light" : "dark");
}

function applyTheme({ preference, contributedTheme }: ApplyThemeInput): void {
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    applySystemBarStyle(contributedTheme.theme.colorScheme);
    return;
  }

  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    applySystemBarStyle("auto");
    return;
  }

  const unistylesName = THEME_TO_UNISTYLES[builtInPreference];
  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(unistylesName);
  applySystemBarStyle(REGISTERED_THEMES[unistylesName].colorScheme);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const options = usePluginThemeCatalog();
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);

  useEffect(() => {
    if (isLoading) return;
    applyTheme({ preference: settings.theme, contributedTheme: selected });
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
    });
  }, [
    isLoading,
    selected,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.syntaxTheme,
  ]);

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
