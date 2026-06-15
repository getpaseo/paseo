export type SupportedLocale = "ar" | "en" | "es" | "fr" | "ko" | "ru" | "zh-CN";
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
  { value: "ko", labelKey: "settings.general.language.options.ko" },
  { value: "ru", labelKey: "settings.general.language.options.ru" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>([
  "system",
  "ar",
  "en",
  "es",
  "fr",
  "ko",
  "ru",
  "zh-CN",
]);
const LANGUAGE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  ar: "العربية",
  en: "English",
  es: "Español",
  fr: "Français",
  ko: "한국어",
  ru: "Русский",
  "zh-CN": "简体中文",
};
const LANGUAGE_NAMES_BY_LOCALE: Record<SupportedLocale, Record<SupportedLocale, string>> = {
  ar: {
    ar: "العربية",
    en: "الإنجليزية",
    es: "الإسبانية",
    fr: "الفرنسية",
    ko: "الكورية",
    ru: "الروسية",
    "zh-CN": "الصينية المبسطة",
  },
  en: {
    ar: "Arabic",
    en: "English",
    es: "Spanish",
    fr: "French",
    ko: "Korean",
    ru: "Russian",
    "zh-CN": "Simplified Chinese",
  },
  es: {
    ar: "árabe",
    en: "inglés",
    es: "español",
    fr: "francés",
    ko: "coreano",
    ru: "ruso",
    "zh-CN": "chino simplificado",
  },
  fr: {
    ar: "arabe",
    en: "anglais",
    es: "espagnol",
    fr: "français",
    ko: "coréen",
    ru: "russe",
    "zh-CN": "chinois simplifié",
  },
  ko: {
    ar: "아랍어",
    en: "영어",
    es: "스페인어",
    fr: "프랑스어",
    ko: "한국어",
    ru: "러시아어",
    "zh-CN": "중국어 간체",
  },
  ru: {
    ar: "арабский",
    en: "английский",
    es: "испанский",
    fr: "французский",
    ko: "корейский",
    ru: "русский",
    "zh-CN": "упрощенный китайский",
  },
  "zh-CN": {
    ar: "阿拉伯语",
    en: "英语",
    es: "西班牙语",
    fr: "法语",
    ko: "韩语",
    ru: "俄语",
    "zh-CN": "简体中文",
  },
};

export function parseAppLanguage(value: unknown): AppLanguage | null {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value as AppLanguage)
    ? (value as AppLanguage)
    : null;
}

export function formatLanguageOptionLabel(
  option: LanguageOption,
  activeLocale: SupportedLocale,
  systemLabel: string,
): string {
  if (option.value === "system") {
    return systemLabel;
  }

  const nativeName = LANGUAGE_NATIVE_NAMES[option.value];
  const activeLanguageName = LANGUAGE_NAMES_BY_LOCALE[activeLocale][option.value];
  if (nativeName === activeLanguageName) {
    return nativeName;
  }

  return `${nativeName} - ${activeLanguageName}`;
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
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
    if (normalized === "es" || normalized.startsWith("es-")) {
      return "es";
    }
    if (normalized === "fr" || normalized.startsWith("fr-")) {
      return "fr";
    }
    if (normalized === "ko" || normalized.startsWith("ko-")) {
      return "ko";
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
