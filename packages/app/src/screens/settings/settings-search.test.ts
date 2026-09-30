import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { SETTINGS_PAGES } from "./settings-pages";
import {
  buildSettingsSearchDocuments,
  matchesSearchQuery,
  normalizeSearchText,
  searchSettings,
  type SettingsSearchDocument,
} from "./settings-search";

const DOCUMENTS: SettingsSearchDocument[] = [
  { pageId: "general", title: "General", sections: ["Language"], hints: ["send, enter"] },
  {
    pageId: "appearance",
    title: "Appearance",
    sections: ["Theme", "Fonts"],
    hints: ["dark mode", "font size"],
  },
  { pageId: "about", title: "About", sections: ["App version"], hints: ["general info"] },
];

function translateFromEnglish(key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined;
    const child: unknown = Reflect.get(node, part);
    return child;
  }, en);
  return typeof value === "string" ? value : key;
}

describe("settings search", () => {
  it("ignores case and accents", () => {
    expect(normalizeSearchText("  Übersicht ")).toBe("ubersicht");
    expect(matchesSearchQuery("Übersicht", "UBER")).toBe(true);
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings(DOCUMENTS, "   ")).toEqual([]);
  });

  it("ranks a title match above sections and hints on other pages", () => {
    const hits = searchSettings(DOCUMENTS, "general");
    expect(hits.map((hit) => hit.pageId)).toEqual(["general", "about"]);
    expect(hits[0]?.detail).toBeNull();
    expect(hits[1]?.detail).toBe("general info");
  });

  it("names the matching section", () => {
    expect(searchSettings(DOCUMENTS, "font")).toEqual([
      { pageId: "appearance", title: "Appearance", detail: "Fonts" },
    ]);
  });

  it("finds pages by hint and reports the hint", () => {
    expect(searchSettings(DOCUMENTS, "dark")).toEqual([
      { pageId: "appearance", title: "Appearance", detail: "dark mode" },
    ]);
  });

  it("requires every word, allowing them to come from different fields", () => {
    expect(searchSettings(DOCUMENTS, "theme dark")).toEqual([
      { pageId: "appearance", title: "Appearance", detail: null },
    ]);
    expect(searchSettings(DOCUMENTS, "theme language")).toEqual([]);
  });

  it("indexes the real catalog through translations", () => {
    const documents = buildSettingsSearchDocuments(SETTINGS_PAGES, translateFromEnglish);
    const fonts = searchSettings(documents, "fonts");
    expect(fonts[0]).toEqual({ pageId: "appearance", title: "Appearance", detail: "Fonts" });
    expect(searchSettings(documents, "github").map((hit) => hit.pageId)).toContain(
      "linked-accounts",
    );
    expect(searchSettings(documents, "mcp").map((hit) => hit.pageId)).toContain("agents");
    expect(searchSettings(documents, "hooks").map((hit) => hit.pageId)).toContain("terminals");
  });
});
