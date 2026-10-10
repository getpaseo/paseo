import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { translateProviderDescription } from "./provider-descriptions";
import {
  providerDescriptionSources,
  providerDescriptionsIt,
} from "./resources/provider-descriptions";

describe("provider description presentation", () => {
  it("translates known Italian descriptions and preserves other locales, unknown IDs and customized copy", async () => {
    const instance = createInstance();
    await instance.init({
      lng: "it",
      fallbackLng: "en",
      resources: { it: { providerDescriptions: providerDescriptionsIt } },
    });
    const original = providerDescriptionSources.codex!;
    expect(translateProviderDescription(instance.t, "codex", original)).toBe(
      providerDescriptionsIt.codex,
    );
    expect(translateProviderDescription(instance.t, "new-provider", "New description")).toBe(
      "New description",
    );
    expect(translateProviderDescription(instance.t, "codex", "My custom instructions")).toBe(
      "My custom instructions",
    );
    expect(translateProviderDescription(instance.t, "toString", "Custom provider")).toBe(
      "Custom provider",
    );
    await instance.changeLanguage("en");
    expect(translateProviderDescription(instance.t, "codex", original)).toBe(original);
    await instance.changeLanguage("fr");
    expect(translateProviderDescription(instance.t, "codex", original)).toBe(original);
  });
});
