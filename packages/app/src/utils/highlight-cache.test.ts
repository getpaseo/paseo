import { describe, expect, it } from "vitest";
import { highlightToKeyedLines, MAX_HIGHLIGHT_CHARS, tokenizeToLines } from "./highlight-cache";

describe("tokenizeToLines", () => {
  it("returns one token array per line for a supported language", () => {
    const lines = tokenizeToLines("const a = 1;\nconst b = 2;", "ts");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0].some((token) => token.style === "keyword")).toBe(true);
  });

  it("returns null when there is no filename", () => {
    expect(tokenizeToLines("whatever", null)).toBeNull();
  });

  it("falls back to style-less per-line tokens for an unknown extension", () => {
    const lines = tokenizeToLines("line one\nline two", "unknownext");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toEqual([{ text: "line one", style: null }]);
  });

  it("returns null above the size cap so callers fall back to plain text", () => {
    const huge = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(tokenizeToLines(huge, "ts")).toBeNull();
  });

  it("serves a cached result on repeat calls (identity-stable)", () => {
    const first = tokenizeToLines("const cached = true;", "ts");
    const second = tokenizeToLines("const cached = true;", "ts");
    expect(first).toBe(second);
  });
});

describe("highlightToKeyedLines", () => {
  it("produces stable keys for lines and tokens", () => {
    const keyed = highlightToKeyedLines("const a = 1;", "ts");
    expect(keyed?.[0].key).toBe("line-0");
    expect(keyed?.[0].tokens[0].key).toBe("0-0");
  });

  it("returns null when highlighting is unavailable", () => {
    expect(highlightToKeyedLines("text", null)).toBeNull();
  });
});
