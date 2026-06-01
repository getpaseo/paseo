import * as Localization from "expo-localization";
import { type ReactNode, useEffect, useMemo } from "react";
import { I18nextProvider } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { i18n } from "./i18next";
import { resolveSupportedLocale } from "./locales";

interface I18nProviderProps {
  children: ReactNode;
}

function getSystemLocales(): string[] {
  if (isWeb && typeof navigator !== "undefined" && navigator.languages.length > 0) {
    return [...navigator.languages];
  }

  return Localization.getLocales().map((locale) => locale.languageTag);
}

export function I18nProvider({ children }: I18nProviderProps) {
  const { settings } = useAppSettings();
  const systemLocales = useMemo(() => getSystemLocales(), []);
  const locale = resolveSupportedLocale(settings.language, systemLocales);

  useEffect(() => {
    if (i18n.language === locale) {
      return;
    }
    void i18n.changeLanguage(locale);
  }, [locale]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
