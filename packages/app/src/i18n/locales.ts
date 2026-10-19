export type SupportedLocale =
  | "ar"
  | "de"
  | "en"
  | "es"
  | "fr"
  | "ja"
  | "ko"
  | "pt-BR"
  | "ru"
  | "zh-CN";
export type AppLanguage = "system" | SupportedLocale;

export interface LanguageOption {
  value: AppLanguage;
  labelKey: string;
}

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "system", labelKey: "settings.general.language.options.system" },
  { value: "ar", labelKey: "settings.general.language.options.ar" },
  { value: "de", labelKey: "settings.general.language.options.de" },
  { value: "en", labelKey: "settings.general.language.options.en" },
  { value: "es", labelKey: "settings.general.language.options.es" },
  { value: "fr", labelKey: "settings.general.language.options.fr" },
  { value: "ja", labelKey: "settings.general.language.options.ja" },
  { value: "ko", labelKey: "settings.general.language.options.ko" },
  { value: "pt-BR", labelKey: "settings.general.language.options.ptBR" },
  { value: "ru", labelKey: "settings.general.language.options.ru" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>([
  "system",
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "pt-BR",
  "ru",
  "zh-CN",
]);
const LANGUAGE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  ar: "العربية",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  "pt-BR": "Português brasileiro",
  ru: "Русский",
  "zh-CN": "简体中文",
};
const LANGUAGE_NAMES_BY_LOCALE: Record<SupportedLocale, Record<SupportedLocale, string>> = {
  ar: {
    ar: "العربية",
    de: "الألمانية",
    en: "الإنجليزية",
    es: "الإسبانية",
    fr: "الفرنسية",
    ja: "اليابانية",
    ko: "الكورية",
    "pt-BR": "البرتغالية البرازيلية",
    ru: "الروسية",
    "zh-CN": "الصينية المبسطة",
  },
  de: {
    ar: "Arabisch",
    de: "Deutsch",
    en: "Englisch",
    es: "Spanisch",
    fr: "Französisch",
    ja: "Japanisch",
    ko: "Koreanisch",
    "pt-BR": "Brasilianisches Portugiesisch",
    ru: "Russisch",
    "zh-CN": "Vereinfachtes Chinesisch",
  },
  en: {
    ar: "Arabic",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    ja: "Japanese",
    ko: "Korean",
    "pt-BR": "Brazilian Portuguese",
    ru: "Russian",
    "zh-CN": "Simplified Chinese",
  },
  es: {
    ar: "árabe",
    de: "alemán",
    en: "inglés",
    es: "español",
    fr: "francés",
    ja: "japonés",
    ko: "coreano",
    "pt-BR": "portugués brasileño",
    ru: "ruso",
    "zh-CN": "chino simplificado",
  },
  fr: {
    ar: "arabe",
    de: "allemand",
    en: "anglais",
    es: "espagnol",
    fr: "français",
    ja: "japonais",
    ko: "coréen",
    "pt-BR": "portugais brésilien",
    ru: "russe",
    "zh-CN": "chinois simplifié",
  },
  ja: {
    ar: "アラビア語",
    de: "ドイツ語",
    en: "英語",
    es: "スペイン語",
    fr: "フランス語",
    ja: "日本語",
    ko: "韓国語",
    "pt-BR": "ブラジルポルトガル語",
    ru: "ロシア語",
    "zh-CN": "簡体字中国語",
  },
  ko: {
    ar: "아랍어",
    de: "독일어",
    en: "영어",
    es: "스페인어",
    fr: "프랑스어",
    ja: "일본어",
    ko: "한국어",
    "pt-BR": "브라질 포르투갈어",
    ru: "러시아어",
    "zh-CN": "중국어 간체",
  },
  "pt-BR": {
    ar: "árabe",
    de: "alemão",
    en: "inglês",
    es: "espanhol",
    fr: "francês",
    ja: "japonês",
    ko: "coreano",
    "pt-BR": "Português brasileiro",
    ru: "russo",
    "zh-CN": "chinês simplificado",
  },
  ru: {
    ar: "арабский",
    de: "немецкий",
    en: "английский",
    es: "испанский",
    fr: "французский",
    ja: "японский",
    ko: "корейский",
    "pt-BR": "бразильский португальский",
    ru: "русский",
    "zh-CN": "упрощенный китайский",
  },
  "zh-CN": {
    ar: "阿拉伯语",
    de: "德语",
    en: "英语",
    es: "西班牙语",
    fr: "法语",
    ja: "日语",
    ko: "韩语",
    "pt-BR": "巴西葡萄牙语",
    ru: "俄语",
    "zh-CN": "简体中文",
  },
};

const REGIONAL_LANGUAGE_LOCALES: Readonly<Record<string, SupportedLocale>> = {
  ar: "ar",
  de: "de",
  en: "en",
  es: "es",
  fr: "fr",
  ja: "ja",
  ko: "ko",
  ru: "ru",
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
    const baseLanguage = normalized.split("-", 1)[0];
    const regionalLocale = REGIONAL_LANGUAGE_LOCALES[baseLanguage];
    if (regionalLocale) {
      return regionalLocale;
    }
    if (normalized === "pt" || normalized === "pt-br") {
      return "pt-BR";
    }
    if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
      return "zh-CN";
    }
  }

  return DEFAULT_LOCALE;
}
