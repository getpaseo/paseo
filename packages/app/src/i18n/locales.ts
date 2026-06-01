export type SupportedLocale = "en" | "zh-CN";
export type AppLanguage = "system" | SupportedLocale;

export interface LanguageOption {
  value: AppLanguage;
  labelKey: string;
}

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "system", labelKey: "settings.general.language.options.system" },
  { value: "en", labelKey: "settings.general.language.options.en" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>(["system", "en", "zh-CN"]);

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
    if (normalized === "zh" || normalized.startsWith("zh-")) {
      return "zh-CN";
    }
  }

  return DEFAULT_LOCALE;
}
