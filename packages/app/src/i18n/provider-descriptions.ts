import type { TFunction } from "i18next";
import { providerDescriptionSources } from "./resources/provider-descriptions";

export function translateProviderDescription(t: TFunction, id: string, original: string): string {
  if (
    !Object.prototype.hasOwnProperty.call(providerDescriptionSources, id) ||
    providerDescriptionSources[id] !== original
  )
    return original;
  return t(id, { ns: "providerDescriptions", defaultValue: original });
}
