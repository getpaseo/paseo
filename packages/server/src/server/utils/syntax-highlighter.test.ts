import { describe, expect, it } from "vitest";
import {
  getSupportedExtensions,
  highlightCode,
  isLanguageSupported,
} from "./syntax-highlighter.js";

function findTokenByText(
  line: string,
  tokens: Array<{ start: number; end: number; style: string }>,
  text: string
) {
  return tokens.find((token) => line.slice(token.start, token.end) === text);
}

describe("syntax-highlighter", () => {
  it("highlights TypeScript using compact span tokens", () => {
    const code = "const value = 42;";
    const [lineTokens] = highlightCode(code, "example.ts");

    expect(lineTokens.length).toBeGreaterThan(0);

    const keyword = findTokenByText(code, lineTokens, "const");
    expect(keyword?.style).toBe("keyword");

    const number = findTokenByText(code, lineTokens, "42");
    expect(number?.style).toBe("number");
  });

  it("returns empty token spans when language is unsupported", () => {
    const highlighted = highlightCode("hello", "README.unknown");
    expect(highlighted).toEqual([[]]);
    expect(isLanguageSupported("README.unknown")).toBe(false);
  });

  it("reports supported extensions without leading dots", () => {
    const extensions = getSupportedExtensions();
    expect(extensions).toContain("ts");
    expect(extensions).toContain("js");
  });
});
