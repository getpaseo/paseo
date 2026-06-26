import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { ar } from "./resources/ar";
import { en } from "./resources/en";
import { es } from "./resources/es";
import { fr } from "./resources/fr";
import { ja } from "./resources/ja";
import { ptBR } from "./resources/pt-BR";
import { ru } from "./resources/ru";
import { zhCN } from "./resources/zh-CN";

const i18n = createInstance();

observeI18nInit(
  i18n.use(initReactI18next).init({
    compatibilityJSON: "v4",
    fallbackLng: "en",
    lng: "en",
    resources: {
      ar: { translation: ar },
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
      ja: { translation: ja },
      "pt-BR": { translation: ptBR },
      ru: { translation: ru },
      "zh-CN": { translation: zhCN },
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  }),
);

export { i18n };
