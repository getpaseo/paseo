import { createInstance, type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { en } from "./resources/en";

// Literal requires keep every locale and supplemental namespace bundled for
// offline use, while evaluating each resource module only when selected.
// Synchronous reads preserve the language provider's contract: translations
// are ready before it renders children.
const bundledTranslations: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    if (namespace === "browserTools") {
      if (language === "en") {
        callback(null, require("./resources/browser-tools").browserToolsEn);
        return;
      }
      if (language === "it") {
        callback(null, require("./resources/browser-tools").browserToolsIt);
        return;
      }
      callback(null, undefined);
      return;
    }

    if (namespace === "workspaceSettings") {
      if (language === "en") {
        callback(null, require("./resources/workspace-settings").workspaceSettingsEn);
        return;
      }
      if (language === "it") {
        callback(null, require("./resources/workspace-settings").workspaceSettingsIt);
        return;
      }
      callback(null, undefined);
      return;
    }

    if (namespace === "terminalSettings") {
      if (language === "en") {
        callback(null, require("./resources/terminal-settings").terminalSettingsEn);
        return;
      }
      if (language === "it") {
        callback(null, require("./resources/terminal-settings").terminalSettingsIt);
        return;
      }
      callback(null, undefined);
      return;
    }

    if (namespace === "addProject") {
      if (language === "en") {
        callback(null, require("./resources/add-project").addProjectEn);
        return;
      }
      if (language === "it") {
        callback(null, require("./resources/add-project").addProjectIt);
        return;
      }
      callback(null, undefined);
      return;
    }

    if (namespace === "providerDescriptions") {
      if (language === "it") {
        callback(null, require("./resources/provider-descriptions").providerDescriptionsIt);
        return;
      }
      callback(null, undefined);
      return;
    }

    if (namespace !== "translation") {
      callback(null, undefined);
      return;
    }

    switch (language) {
      case "en":
        callback(null, en);
        return;
      case "ar":
        callback(null, require("./resources/ar").ar);
        return;
      case "es":
        callback(null, require("./resources/es").es);
        return;
      case "fr":
        callback(null, require("./resources/fr").fr);
        return;
      case "it":
        callback(null, require("./resources/it").it);
        return;
      case "ja":
        callback(null, require("./resources/ja").ja);
        return;
      case "ko":
        callback(null, require("./resources/ko").ko);
        return;
      case "pt-BR":
        callback(null, require("./resources/pt-BR").ptBR);
        return;
      case "ru":
        callback(null, require("./resources/ru").ru);
        return;
      case "zh-CN":
        callback(null, require("./resources/zh-CN").zhCN);
        return;
      default:
        callback(null, undefined);
    }
  },
};

const i18n = createInstance();

observeI18nInit(
  i18n
    .use(bundledTranslations)
    .use(initReactI18next)
    .init({
      compatibilityJSON: "v4",
      fallbackLng: "en",
      lng: "en",
      partialBundledLanguages: true,
      resources: {
        en: { translation: en },
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
