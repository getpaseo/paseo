import { describe, expect, it } from "vitest";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  resolveSupportedLocale,
} from "./locales";

describe("parseAppLanguage", () => {
  it("accepts system and all supported language locales", () => {
    expect(
      ["system", "ar", "en", "es", "fr", "ja", "pt-BR", "ru", "zh-CN"].map(parseAppLanguage),
    ).toEqual(["system", "ar", "en", "es", "fr", "ja", "pt-BR", "ru", "zh-CN"]);
  });

  it("returns null for unknown values", () => {
    expect(parseAppLanguage("de")).toBeNull();
    expect(parseAppLanguage(null)).toBeNull();
  });

  it("offers system plus all supported languages", () => {
    expect(LANGUAGE_OPTIONS.map((option) => option.value)).toEqual([
      "system",
      "ar",
      "en",
      "es",
      "fr",
      "ja",
      "pt-BR",
      "ru",
      "zh-CN",
    ]);
  });
});

describe("formatLanguageOptionLabel", () => {
  it("shows the native language name and English name in English UI", () => {
    const arabic = LANGUAGE_OPTIONS.find((option) => option.value === "ar");
    const japanese = LANGUAGE_OPTIONS.find((option) => option.value === "ja");
    const portuguese = LANGUAGE_OPTIONS.find((option) => option.value === "pt-BR");
    const spanish = LANGUAGE_OPTIONS.find((option) => option.value === "es");
    const chinese = LANGUAGE_OPTIONS.find((option) => option.value === "zh-CN");

    expect([
      formatLanguageOptionLabel(arabic!, "en", "System"),
      formatLanguageOptionLabel(japanese!, "en", "System"),
      formatLanguageOptionLabel(portuguese!, "en", "System"),
      formatLanguageOptionLabel(spanish!, "en", "System"),
      formatLanguageOptionLabel(chinese!, "en", "System"),
    ]).toEqual([
      "العربية - Arabic",
      "日本語 - Japanese",
      "Português brasileiro - Brazilian Portuguese",
      "Español - Spanish",
      "简体中文 - Simplified Chinese",
    ]);
  });

  it("shows the native language name and Chinese name in Chinese UI", () => {
    const arabic = LANGUAGE_OPTIONS.find((option) => option.value === "ar");
    const english = LANGUAGE_OPTIONS.find((option) => option.value === "en");
    const spanish = LANGUAGE_OPTIONS.find((option) => option.value === "es");

    expect([
      formatLanguageOptionLabel(arabic!, "zh-CN", "系统"),
      formatLanguageOptionLabel(english!, "zh-CN", "系统"),
      formatLanguageOptionLabel(spanish!, "zh-CN", "系统"),
    ]).toEqual(["العربية - 阿拉伯语", "English - 英语", "Español - 西班牙语"]);
  });

  it("uses a single label when both language names match", () => {
    const english = LANGUAGE_OPTIONS.find((option) => option.value === "en");
    const japanese = LANGUAGE_OPTIONS.find((option) => option.value === "ja");
    const portuguese = LANGUAGE_OPTIONS.find((option) => option.value === "pt-BR");

    expect(formatLanguageOptionLabel(english!, "en", "System")).toBe("English");
    expect(formatLanguageOptionLabel(japanese!, "ja", "システム")).toBe("日本語");
    expect(formatLanguageOptionLabel(portuguese!, "pt-BR", "Sistema")).toBe("Português brasileiro");
  });

  it("uses the active-language name for System", () => {
    const system = LANGUAGE_OPTIONS.find((option) => option.value === "system");

    expect(formatLanguageOptionLabel(system!, "zh-CN", "系统")).toBe("系统");
  });
});

describe("resolveSupportedLocale", () => {
  it("respects explicit language choices", () => {
    expect(resolveSupportedLocale("ar", ["en-US"])).toBe("ar");
    expect(resolveSupportedLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveSupportedLocale("es", ["en-US"])).toBe("es");
    expect(resolveSupportedLocale("fr", ["en-US"])).toBe("fr");
    expect(resolveSupportedLocale("ja", ["en-US"])).toBe("ja");
    expect(resolveSupportedLocale("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(resolveSupportedLocale("ru", ["en-US"])).toBe("ru");
    expect(resolveSupportedLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("maps supported system locales", () => {
    expect(resolveSupportedLocale("system", ["ar-EG"])).toBe("ar");
    expect(resolveSupportedLocale("system", ["en-US"])).toBe("en");
    expect(resolveSupportedLocale("system", ["es-MX"])).toBe("es");
    expect(resolveSupportedLocale("system", ["fr-CA"])).toBe("fr");
    expect(resolveSupportedLocale("system", ["ja-JP"])).toBe("ja");
    expect(resolveSupportedLocale("system", ["pt-BR"])).toBe("pt-BR");
    expect(resolveSupportedLocale("system", ["pt"])).toBe("pt-BR");
    expect(resolveSupportedLocale("system", ["ru-RU"])).toBe("ru");
  });

  it("does not map non-Brazilian Portuguese system locales to Brazilian Portuguese", () => {
    expect(resolveSupportedLocale("system", ["pt-PT"])).toBe("en");
    expect(resolveSupportedLocale("system", ["pt-AO"])).toBe("en");
  });

  it("keeps English when Spanish is a secondary system language", () => {
    expect(resolveSupportedLocale("system", ["en-US", "es-GB"])).toBe("en");
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
