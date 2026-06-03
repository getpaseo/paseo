import { describe, expect, it } from "vitest";
import { LANGUAGE_OPTIONS, parseAppLanguage, resolveSupportedLocale } from "./locales";

describe("parseAppLanguage", () => {
  it("accepts system and all UN official language locales", () => {
    expect(["system", "ar", "en", "es", "fr", "ru", "zh-CN"].map(parseAppLanguage)).toEqual([
      "system",
      "ar",
      "en",
      "es",
      "fr",
      "ru",
      "zh-CN",
    ]);
  });

  it("returns null for unknown values", () => {
    expect(parseAppLanguage("de")).toBeNull();
    expect(parseAppLanguage(null)).toBeNull();
  });

  it("offers system plus the six UN official languages", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.value)).toEqual([
      "system",
      "ar",
      "en",
      "es",
      "fr",
      "ru",
      "zh-CN",
    ]);
  });
});

describe("resolveSupportedLocale", () => {
  it("respects explicit language choices", () => {
    expect(resolveSupportedLocale("ar", ["en-US"])).toBe("ar");
    expect(resolveSupportedLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveSupportedLocale("es", ["en-US"])).toBe("es");
    expect(resolveSupportedLocale("fr", ["en-US"])).toBe("fr");
    expect(resolveSupportedLocale("ru", ["en-US"])).toBe("ru");
    expect(resolveSupportedLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("maps UN official system locales", () => {
    expect(resolveSupportedLocale("system", ["ar-EG"])).toBe("ar");
    expect(resolveSupportedLocale("system", ["es-MX"])).toBe("es");
    expect(resolveSupportedLocale("system", ["fr-CA"])).toBe("fr");
    expect(resolveSupportedLocale("system", ["ru-RU"])).toBe("ru");
  });

  it("maps Chinese system locales to Simplified Chinese", () => {
    expect(resolveSupportedLocale("system", ["zh"])).toBe("zh-CN");
    expect(resolveSupportedLocale("system", ["zh-CN"])).toBe("zh-CN");
    expect(resolveSupportedLocale("system", ["zh-Hans-US"])).toBe("zh-CN");
  });

  it("does not map Traditional Chinese system locales to Simplified Chinese", () => {
    expect(resolveSupportedLocale("system", ["zh-TW"])).toBe("en");
    expect(resolveSupportedLocale("system", ["zh-Hant"])).toBe("en");
    expect(resolveSupportedLocale("system", ["zh-HK"])).toBe("en");
  });

  it("maps unsupported or missing system locales to English", () => {
    expect(resolveSupportedLocale("system", ["de-DE"])).toBe("en");
    expect(resolveSupportedLocale("system", [])).toBe("en");
  });
});
