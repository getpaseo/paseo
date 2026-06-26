import { describe, expect, it } from "vitest";
import { isMermaidFenceLanguage, normalizeFenceLanguage } from "./fence-language";

describe("normalizeFenceLanguage", () => {
  it("returns the first token lowercased", () => {
    expect(normalizeFenceLanguage("TypeScript")).toBe("typescript");
    expect(normalizeFenceLanguage("ts {1,3}")).toBe("ts");
  });

  it("returns null for empty info", () => {
    expect(normalizeFenceLanguage(null)).toBeNull();
    expect(normalizeFenceLanguage("   ")).toBeNull();
  });
});

describe("isMermaidFenceLanguage", () => {
  it("detects mermaid and mmd", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("Mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("mmd")).toBe(true);
  });

  it("rejects other fence languages", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("markdown")).toBe(false);
  });
});
