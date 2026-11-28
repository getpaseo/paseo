import { createInstance, type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { addProjectEn } from "./resources/add-project";
import { browserToolsEn } from "./resources/browser-tools";
import { en } from "./resources/en";
import { terminalSettingsEn } from "./resources/terminal-settings";
import { workspaceSettingsEn } from "./resources/workspace-settings";

// Literal requires keep every locale and supplemental namespace bundled for
// offline use, while evaluating each resource module only when selected.
// Synchronous reads preserve the language provider's contract: translations
// are ready before it renders children.
function bundledSupplementalResource(language: string, namespace: string) {
  switch (namespace) {
    case "browserTools":
      if (language === "en") {
        return browserToolsEn;
      }
      if (language === "it") {
        return require("./resources/browser-tools").browserToolsIt;
      }
      return;
    case "workspaceSettings":
      if (language === "en") {
        return workspaceSettingsEn;
      }
      if (language === "it") {
        return require("./resources/workspace-settings").workspaceSettingsIt;
      }
      return;
    case "terminalSettings":
      if (language === "en") {
        return terminalSettingsEn;
      }
      if (language === "it") {
        return require("./resources/terminal-settings").terminalSettingsIt;
      }
      return;
    case "addProject":
      if (language === "en") {
        return addProjectEn;
      }
      if (language === "it") {
        return require("./resources/add-project").addProjectIt;
      }
      return;
    case "providerDescriptions":
      if (language === "it") {
        return require("./resources/provider-descriptions").providerDescriptionsIt;
      }
      return;
    default:
      return;
  }
}

function bundledTranslationResource(language: string) {
  switch (language) {
    case "en":
      return en;
    case "ar":
      return require("./resources/ar").ar;
    case "es":
      return require("./resources/es").es;
    case "fr":
      return require("./resources/fr").fr;
    case "it":
      return require("./resources/it").it;
    case "ja":
      return require("./resources/ja").ja;
    case "ko":
      return require("./resources/ko").ko;
    case "pt-BR":
      return require("./resources/pt-BR").ptBR;
    case "ru":
      return require("./resources/ru").ru;
    case "zh-CN":
      return require("./resources/zh-CN").zhCN;
    default:
      return;
  }
}

const bundledTranslations: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    const resource =
      namespace === "translation"
        ? bundledTranslationResource(language)
        : bundledSupplementalResource(language, namespace);
    callback(null, resource);
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
        en: {
          translation: en,
          browserTools: browserToolsEn,
          workspaceSettings: workspaceSettingsEn,
          terminalSettings: terminalSettingsEn,
          addProject: addProjectEn,
        },
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
