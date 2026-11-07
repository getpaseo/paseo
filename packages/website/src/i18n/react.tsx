import { useParams } from "@tanstack/react-router";
import { type ReactNode, useCallback } from "react";
import { I18nextProvider } from "react-i18next";
import { type Locale, localizePath, routeLocale } from "./locale";
import { getI18n } from "./translator";

/** The page's language, read from the URL's `{-$locale}` segment. */
export function useLocale(): Locale {
  return routeLocale(useParams({ strict: false }));
}

/** Provides the page language's translations to `useTranslation` below it. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return <I18nextProvider i18n={getI18n(locale)}>{children}</I18nextProvider>;
}

/** Maps a language-neutral site path to the current language's URL for plain anchors. */
export function useLocalizePath(): (path: string) => string {
  const locale = useLocale();
  return useCallback((path: string) => localizePath(path, locale), [locale]);
}
