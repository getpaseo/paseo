import { createInstance, type i18n, type TFunction } from "i18next";
import en from "./resources/en.json";
import zhCN from "./resources/zh-CN.json";
import { DEFAULT_LOCALE, type Locale } from "./locale";

const RESOURCES: Record<Locale, typeof en> = { en, "zh-CN": zhCN };

function createI18n(locale: Locale): i18n {
  const instance = createInstance({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [locale, DEFAULT_LOCALE],
    resources: {
      [locale]: { translation: RESOURCES[locale] },
      [DEFAULT_LOCALE]: { translation: RESOURCES[DEFAULT_LOCALE] },
    },
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  void instance.init();
  return instance;
}

/**
 * One i18next instance per language, created once and never switched. Requests in different
 * languages share no translation state, so one server process can render them concurrently.
 */
const INSTANCES: Record<Locale, i18n> = {
  en: createI18n("en"),
  "zh-CN": createI18n("zh-CN"),
};

/** The instance for `LocaleProvider`; the `~/i18n` module does not export it. */
export function getI18n(locale: Locale): i18n {
  return INSTANCES[locale];
}

/** Interface copy for code that runs outside React, such as route `head` functions. */
export function getTranslator(locale: Locale): TFunction {
  return INSTANCES[locale].t;
}
