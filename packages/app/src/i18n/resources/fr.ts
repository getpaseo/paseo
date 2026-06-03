import { en } from "./en";

export const fr = {
  ...en,
  settings: {
    ...en.settings,
    general: {
      ...en.settings.general,
      language: {
        ...en.settings.general.language,
        options: {
          ...en.settings.general.language.options,
          ar: "العربية",
          en: "English",
          es: "Español",
          fr: "Français",
          ru: "Русский",
          zhCN: "中文",
        },
      },
    },
  },
} as const;
