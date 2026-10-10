import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import {
  DEFAULT_THEME_PREFERENCE,
  resolveContentMaxWidth,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import { useLoadedPluginHosts } from "@/plugins/registry";
import {
  pluginThemeOption,
  rememberPluginThemeHost,
  resolveContributedTheme,
  snapshotPluginTheme,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import { PLUGIN_THEME_NAMES, PLUGIN_THEME_PREFERENCE, THEME_TO_UNISTYLES } from "@/styles/theme";
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
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);
  const options = usePluginThemeCatalog();
  const loadedHosts = useLoadedPluginHosts();
  const usesPluginTheme = settings.theme === PLUGIN_THEME_PREFERENCE;
  const { selected: live, snapshot } = useMemo(
    () =>
      usesPluginTheme
        ? resolveContributedTheme({
            pluginThemeId: settings.pluginThemeId,
            options,
            stored: settings.pluginThemeSnapshot,
            loadedHosts,
          })
        : { selected: null, snapshot: settings.pluginThemeSnapshot },
    [loadedHosts, options, settings.pluginThemeId, settings.pluginThemeSnapshot, usesPluginTheme],
  );
  // Until a host contributes the theme, the stored snapshot paints the app and names the picker.
  const selected = useMemo(() => {
    if (live) return live;
    return usesPluginTheme && snapshot ? pluginThemeOption(snapshot) : null;
  }, [live, snapshot, usesPluginTheme]);

  useEffect(() => {
    if (isLoading || snapshot === settings.pluginThemeSnapshot) return;
    void updateSettings({ pluginThemeSnapshot: snapshot });
  }, [isLoading, snapshot, settings.pluginThemeSnapshot, updateSettings]);

  useEffect(() => {
    if (isLoading) return;
    applyTheme({ preference: settings.theme, contributedTheme: selected });
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      contentMaxWidth: resolveContentMaxWidth({ contentMaxWidth: settings.contentMaxWidth }),
      syntaxTheme: settings.syntaxTheme,
    });
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    selected,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.contentMaxWidth,
    settings.syntaxTheme,
  ]);

  const select = useCallback(
    (option: PluginThemeOption) => {
      rememberPluginThemeHost(option);
      void updateSettings({
        theme: PLUGIN_THEME_PREFERENCE,
        pluginThemeId: option.id,
        pluginThemeSnapshot: snapshotPluginTheme(option),
      });
    },
    [updateSettings],
  );
  const value = useMemo(() => ({ options, selected, select }), [options, selected, select]);

  // The first settings load changes appearance keys. Mount screens only after applying it
  // so startup does not destroy and recreate an already-visible workspace.
  if (!hasAppliedAppearance) return null;

  return (
    <ContributedThemesContext.Provider value={value}>{children}</ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
