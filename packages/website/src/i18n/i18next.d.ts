import type en from "./resources/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}
