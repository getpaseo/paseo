import { describe, expect, it } from "vitest";
import { parseAppLanguage, resolveSupportedLocale } from "./locales";

describe("parseAppLanguage", () => {
  it("accepts system and supported locales", () => {
    expect(parseAppLanguage("system")).toBe("system");
    expect(parseAppLanguage("en")).toBe("en");
    expect(parseAppLanguage("zh-CN")).toBe("zh-CN");
  });

  it("returns null for unknown values", () => {
    expect(parseAppLanguage("fr")).toBeNull();
    expect(parseAppLanguage(null)).toBeNull();
  });
});

describe("resolveSupportedLocale", () => {
  it("respects explicit language choices", () => {
    expect(resolveSupportedLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveSupportedLocale("zh-CN", ["en-US"])).toBe("zh-CN");
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
    expect(resolveSupportedLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveSupportedLocale("system", [])).toBe("en");
  });
});
