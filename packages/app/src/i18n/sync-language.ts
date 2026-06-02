import type { SupportedLocale } from "./locales";

interface I18nLanguageController {
  language?: string;
  changeLanguage: (language: SupportedLocale) => Promise<unknown>;
}

type I18nErrorReporter = (message: string, error: unknown) => void;

export const reportI18nError: I18nErrorReporter = (message, error) => {
  console.error(message, error);
};

export function ensureI18nLanguageForRender(
  locale: SupportedLocale,
  i18n: I18nLanguageController,
  reportError: I18nErrorReporter = reportI18nError,
): void {
  if (i18n.language === locale) {
    return;
  }

  i18n
    .changeLanguage(locale)
    .catch((error) => reportError("[i18n] Failed to change language", error));
}
