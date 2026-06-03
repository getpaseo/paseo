export type SupportedLocale = "ar" | "en" | "es" | "fr" | "ru" | "zh-CN";
export type AppLanguage = "system" | SupportedLocale;

export interface LanguageOption {
  value: AppLanguage;
  labelKey: string;
}

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "system", labelKey: "settings.general.language.options.system" },
  { value: "ar", labelKey: "settings.general.language.options.ar" },
  { value: "en", labelKey: "settings.general.language.options.en" },
  { value: "es", labelKey: "settings.general.language.options.es" },
  { value: "fr", labelKey: "settings.general.language.options.fr" },
  { value: "ru", labelKey: "settings.general.language.options.ru" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>(["system", "ar", "en", "es", "fr", "ru", "zh-CN"]);

export function parseAppLanguage(value: unknown): AppLanguage | null {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value as AppLanguage)
    ? (value as AppLanguage)
    : null;
}

export function resolveSupportedLocale(
  language: AppLanguage,
  systemLocales: readonly string[],
): SupportedLocale {
  if (language !== "system") {
    return language;
  }

  for (const locale of systemLocales) {
    const normalized = locale.toLowerCase();
    if (normalized === "ar" || normalized.startsWith("ar-")) {
      return "ar";
    }
    if (normalized === "es" || normalized.startsWith("es-")) {
      return "es";
    }
    if (normalized === "fr" || normalized.startsWith("fr-")) {
      return "fr";
    }
    if (normalized === "ru" || normalized.startsWith("ru-")) {
      return "ru";
    }
    if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
      return "zh-CN";
    }
  }

  return DEFAULT_LOCALE;
}
