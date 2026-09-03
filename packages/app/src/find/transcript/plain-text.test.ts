import { describe, expect, it } from "vitest";
import { assistantPlainText } from "./plain-text";

describe("assistantPlainText", () => {
  it("drops emphasis markers and keeps the emphasized words", () => {
    expect(assistantPlainText("Hello **bold** and *em* and ~~gone~~")).toBe(
      "Hello bold and em and gone",
    );
  });

  it("keeps link text and drops the URL, which is never painted", () => {
    expect(assistantPlainText("See [the docs](https://example.com/docs) now")).toBe(
      "See the docs now",
    );
  });

  it("keeps inline code without its backticks", () => {
    expect(assistantPlainText("Use `npm run dev` today")).toBe("Use npm run dev today");
  });

  it("keeps a fence body without the trailing newline the code block strips", () => {
    expect(assistantPlainText("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("keeps an indented code block", () => {
    expect(assistantPlainText("    indented code\n")).toBe("indented code");
  });

  it("skips a diagram fence, which renders a diagram rather than its source", () => {
    expect(assistantPlainText("```mermaid\ngraph TD;\nA-->B;\n```")).toBe("");
  });

  it("runs list items together, because the markers are excluded from the DOM walk", () => {
    expect(assistantPlainText("- first\n- second")).toBe("firstsecond");
    expect(assistantPlainText("1. one\n2. two")).toBe("onetwo");
  });

  it("runs table cells together, because the pipes are not painted", () => {
    expect(assistantPlainText("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("ab12");
  });

  it("renders both break kinds as the newline the renderer emits", () => {
    expect(assistantPlainText("line one  \nline two")).toBe("line one\nline two");
    expect(assistantPlainText("line one\nline two")).toBe("line one\nline two");
  });

  it("drops heading markup", () => {
    expect(assistantPlainText("## Heading\n\nBody text")).toBe("Heading\nBody text");
  });

  it("drops images, which paint no alt text", () => {
    expect(assistantPlainText("before ![alt text](https://example.com/x.png) after")).toBe(
      "before  after",
    );
  });

  it("decodes entities the way the renderer does", () => {
    expect(assistantPlainText("a &amp; b")).toBe("a & b");
  });

  it("separates blocks so a query can never match across two DOM roots", () => {
    expect(assistantPlainText("para one\n\npara two")).toBe("para one\npara two");
  });

  it("keeps blockquote text", () => {
    expect(assistantPlainText("> quoted text")).toBe("quoted text");
  });

  it("is empty for an empty message", () => {
    expect(assistantPlainText("")).toBe("");
  });
});
