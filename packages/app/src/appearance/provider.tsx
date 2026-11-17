import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useFonts } from "expo-font";
import { resolveContentMaxWidth, useAppSettings } from "@/hooks/use-settings";
import { useColorScheme } from "@/hooks/use-color-scheme";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import { PLUGIN_THEME_PREFERENCE } from "@/styles/theme";
import { applyAppearance, applyTheme } from "./apply";
import { AppearanceSystemBars } from "./system-bars";
import { useSystemAccentColor } from "./use-system-accent";

interface ContributedThemes {
  options: PluginThemeOption[];
  selected: PluginThemeOption | null;
  select: (option: PluginThemeOption) => void;
}

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const [fontsLoaded, fontLoadError] = useFonts({
    Geist: require("../../assets/fonts/Geist-VariableFont.ttf"),
    "Geist Mono": require("../../assets/fonts/GeistMono-VariableFont.ttf"),
  });
  const systemColorScheme = useColorScheme();
  const systemAccent = useSystemAccentColor();
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);
  const options = usePluginThemeCatalog();
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);
  const appliedSystemAccent = selected ? null : systemAccent;

  useEffect(() => {
    if (isLoading) return;
    applyTheme({
      preference: settings.theme,
      preferredDarkTheme: settings.preferredDarkTheme,
      contributedTheme: selected,
      systemColorScheme,
    });
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      contentMaxWidth: resolveContentMaxWidth({ contentMaxWidth: settings.contentMaxWidth }),
      syntaxTheme: settings.syntaxTheme,
      systemAccent: appliedSystemAccent,
    });
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    selected,
    settings.theme,
    settings.preferredDarkTheme,
    systemColorScheme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.contentMaxWidth,
    settings.syntaxTheme,
    appliedSystemAccent,
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

  // The first settings load changes appearance keys. Mount screens only after applying it
  // so startup does not destroy and recreate an already-visible workspace.
  if (!hasAppliedAppearance || (!fontsLoaded && !fontLoadError)) return null;

  return (
    <ContributedThemesContext.Provider value={value}>
      <AppearanceSystemBars />
      {children}
    </ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
