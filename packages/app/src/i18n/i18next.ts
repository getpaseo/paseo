import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./resources/en";
import { zhCN } from "./resources/zh-CN";

void i18n.use(initReactI18next).init({
  compatibilityJSON: "v4",
  fallbackLng: "en",
  lng: "en",
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export { i18n };
