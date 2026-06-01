import { describe, it, expect } from "vitest";
import { highlightCode, highlightLine } from "../highlighter.js";

describe("highlightCode", () => {
  it("highlights JavaScript code with correct token styles", () => {
    const code = "const x = 42;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(1);
    const tokens = result[0];
    expect(tokens.length).toBeGreaterThan(1);

    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");

    const numberToken = tokens.find((t) => t.text === "42");
    expect(numberToken?.style).toBe("number");
  });

  it("highlights Python code", () => {
    const code = 'def hello():\n    print("world")';
    const result = highlightCode(code, "test.py");

    expect(result).toHaveLength(2);

    const defToken = result[0].find((t) => t.text === "def");
    expect(defToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("world"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Swift code", () => {
    const code = 'struct Greeter {\n    let message = "hello"\n}';
    const result = highlightCode(code, "test.swift");

    expect(result).toHaveLength(3);

    const structToken = result[0].find((t) => t.text === "struct");
    expect(structToken?.style).toBe("keyword");

    const typeToken = result[0].find((t) => t.text === "Greeter");
    expect(typeToken?.style).toBe("definition");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights TSX code with correct dialect", () => {
    const code = 'const el = <div className="test">hello</div>;';
    const result = highlightCode(code, "test.tsx");

    expect(result).toHaveLength(1);
    const tokens = result[0];

    const constToken = tokens.find((t) => t.text === "const");
    expect(constToken?.style).toBe("keyword");

    const tagToken = tokens.find((t) => t.text === "div");
    expect(tagToken).toBeDefined();
  });

  it("returns unhighlighted tokens for unsupported extensions", () => {
    const code = "hello world\nsecond line";
    const result = highlightCode(code, "test.xyz");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([{ text: "hello world", style: null }]);
    expect(result[1]).toEqual([{ text: "second line", style: null }]);
  });

  it("splits multi-line code into separate line arrays", () => {
    const code = "line1\nline2\nline3";
    const result = highlightCode(code, "test.txt");

    expect(result).toHaveLength(3);
  });

  it("handles empty lines", () => {
    const code = "const a = 1;\n\nconst b = 2;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(3);
    expect(result[1]).toEqual([{ text: "", style: null }]);
  });

  it("returns a single empty line for empty input", () => {
    expect(highlightCode("", "test.ts")).toEqual([[{ text: "", style: null }]]);
  });

  it("returns valid HighlightStyle values for all tokens", () => {
    const validStyles = new Set([
      "keyword",
      "comment",
      "string",
      "number",
      "literal",
      "function",
      "definition",
      "class",
      "type",
      "tag",
      "attribute",
      "property",
      "variable",
      "operator",
      "punctuation",
      "regexp",
      "escape",
      "meta",
      "heading",
      "link",
      null,
    ]);

    const code = '// comment\nconst x: number = 42;\nfunction foo() { return "bar"; }';
    const result = highlightCode(code, "test.ts");

    for (const line of result) {
      for (const token of line) {
        expect(validStyles.has(token.style)).toBe(true);
      }
    }
  });
});

describe("highlightLine", () => {
  it("highlights a single line", () => {
    const tokens = highlightLine("const x = 1;", "test.js");

    expect(tokens.length).toBeGreaterThan(1);
    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");
  });

  it("returns unhighlighted token for unsupported files", () => {
    const tokens = highlightLine("hello", "test.xyz");

    expect(tokens).toEqual([{ text: "hello", style: null }]);
  });
});
