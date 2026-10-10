import type { TOptions } from "i18next";
import { i18n } from "./i18next";
import type { addProjectEn } from "./resources/add-project";
export function addProjectCopy(key: keyof typeof addProjectEn, options?: TOptions): string {
  return i18n.t(key, { ...options, ns: "addProject" });
}
