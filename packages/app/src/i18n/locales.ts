export type SupportedLocale = "ar" | "en" | "es" | "fr" | "ja" | "pt-BR" | "ru" | "zh-CN";
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
  { value: "ja", labelKey: "settings.general.language.options.ja" },
  { value: "pt-BR", labelKey: "settings.general.language.options.ptBR" },
  { value: "ru", labelKey: "settings.general.language.options.ru" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>([
  "system",
  "ar",
  "en",
  "es",
  "fr",
  "ja",
  "pt-BR",
  "ru",
  "zh-CN",
]);
const LANGUAGE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  ar: "العربية",
  en: "English",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  "pt-BR": "Português brasileiro",
  ru: "Русский",
  "zh-CN": "简体中文",
};
const LANGUAGE_NAMES_BY_LOCALE: Record<SupportedLocale, Record<SupportedLocale, string>> = {
  ar: {
    ar: "العربية",
    en: "الإنجليزية",
    es: "الإسبانية",
    fr: "الفرنسية",
    ja: "اليابانية",
    "pt-BR": "البرتغالية البرازيلية",
    ru: "الروسية",
    "zh-CN": "الصينية المبسطة",
  },
  en: {
    ar: "Arabic",
    en: "English",
    es: "Spanish",
    fr: "French",
    ja: "Japanese",
    "pt-BR": "Brazilian Portuguese",
    ru: "Russian",
    "zh-CN": "Simplified Chinese",
  },
  es: {
    ar: "árabe",
    en: "inglés",
    es: "español",
    fr: "francés",
    ja: "japonés",
    "pt-BR": "portugués brasileño",
    ru: "ruso",
    "zh-CN": "chino simplificado",
  },
  fr: {
    ar: "arabe",
    en: "anglais",
    es: "espagnol",
    fr: "français",
    ja: "japonais",
    "pt-BR": "portugais brésilien",
    ru: "russe",
    "zh-CN": "chinois simplifié",
  },
  ja: {
    ar: "アラビア語",
    en: "英語",
    es: "スペイン語",
    fr: "フランス語",
    ja: "日本語",
    "pt-BR": "ブラジルポルトガル語",
    ru: "ロシア語",
    "zh-CN": "簡体字中国語",
  },
  "pt-BR": {
    ar: "árabe",
    en: "inglês",
    es: "espanhol",
    fr: "francês",
    ja: "japonês",
    "pt-BR": "Português brasileiro",
    ru: "russo",
    "zh-CN": "chinês simplificado",
  },
  ru: {
    ar: "арабский",
    en: "английский",
    es: "испанский",
    fr: "французский",
    ja: "японский",
    "pt-BR": "бразильский португальский",
    ru: "русский",
    "zh-CN": "упрощенный китайский",
  },
  "zh-CN": {
    ar: "阿拉伯语",
    en: "英语",
    es: "西班牙语",
    fr: "法语",
    ja: "日语",
    "pt-BR": "巴西葡萄牙语",
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
    if (normalized === "ja" || normalized.startsWith("ja-")) {
      return "ja";
    }
    if (normalized === "pt" || normalized === "pt-br") {
      return "pt-BR";
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
