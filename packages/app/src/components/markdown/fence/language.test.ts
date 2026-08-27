import { describe, expect, it } from "vitest";
import { getMarkdownFenceLanguage } from "./language";

describe("getMarkdownFenceLanguage", () => {
  it("normalizes the first info-string token", () => {
    expect(getMarkdownFenceLanguage(" Sirena theme=dark ")).toBe("sirena");
    expect(getMarkdownFenceLanguage("TypeScript title=example")).toBe("typescript");
  });

  it("returns null when no language is declared", () => {
    expect(getMarkdownFenceLanguage("")).toBeNull();
    expect(getMarkdownFenceLanguage(null)).toBeNull();
    expect(getMarkdownFenceLanguage(undefined)).toBeNull();
  });
});
