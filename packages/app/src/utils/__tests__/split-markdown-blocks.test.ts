import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "../split-markdown-blocks";

describe("splitMarkdownBlocks", () => {
  it("returns a single block for a single paragraph", () => {
    expect(splitMarkdownBlocks("Hello world")).toEqual(["Hello world"]);
  });

  it("splits two paragraphs separated by a double newline", () => {
    expect(splitMarkdownBlocks("First paragraph\n\nSecond paragraph")).toEqual([
      "First paragraph",
      "Second paragraph",
    ]);
  });

  it("keeps a fenced code block with internal double newlines as one block", () => {
    expect(splitMarkdownBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```")).toEqual([
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    ]);
  });

  it("does not treat 4-space-indented backticks as a fence", () => {
    expect(splitMarkdownBlocks("Before\n\n    ```\n    code\n    ```\n\nAfter")).toEqual([
      "Before",
      "    ```\n    code\n    ```",
      "After",
    ]);
  });

  it("handles tilde fences", () => {
    expect(splitMarkdownBlocks("Before\n\n~~~\ncode\n~~~\n\nAfter")).toEqual([
      "Before",
      "~~~\ncode\n~~~",
      "After",
    ]);
  });

  it("splits mixed paragraph, code fence, and paragraph content into three blocks", () => {
    expect(
      splitMarkdownBlocks(
        "Intro paragraph\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro paragraph",
      ),
    ).toEqual(["Intro paragraph", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Outro paragraph"]);
  });

  it("keeps everything from an unclosed fence start as one block for streaming content", () => {
    expect(splitMarkdownBlocks("Before fence\n\n```ts\nconst a = 1;\n\nconst b = 2;")).toEqual([
      "Before fence",
      "```ts\nconst a = 1;\n\nconst b = 2;",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
  });

  it("splits a heading followed by a paragraph into two blocks", () => {
    expect(splitMarkdownBlocks("# Heading\n\nParagraph text")).toEqual([
      "# Heading",
      "Paragraph text",
    ]);
  });

  it("keeps consecutive list items together when there is no double newline", () => {
    expect(splitMarkdownBlocks("- First item\n- Second item\n- Third item")).toEqual([
      "- First item\n- Second item\n- Third item",
    ]);
  });

  it("keeps a loose nested list in its outer list block", () => {
    expect(
      splitMarkdownBlocks(
        "Before\n\n3. Outer three\n\n   7. Inner seven\n   8. Inner eight\n\nAfter",
      ),
    ).toEqual(["Before", "3. Outer three\n\n   7. Inner seven\n   8. Inner eight", "After"]);
  });

  it("keeps a link reference definition with the paragraph that uses it", () => {
    expect(splitMarkdownBlocks("See the [docs][d].\n\n[d]: https://example.com")).toEqual([
      "See the [docs][d].\n\n[d]: https://example.com",
    ]);
  });

  it("folds a leading definition-only block into the block below it", () => {
    expect(splitMarkdownBlocks('[d]: https://example.com "Docs"\n\nSee the [docs][d].')).toEqual([
      '[d]: https://example.com "Docs"\n\nSee the [docs][d].',
    ]);
  });

  it("folds several definition lines and several definition blocks into one block", () => {
    expect(
      splitMarkdownBlocks(
        "See [one][a] and [two][b].\n\n[a]: https://example.com/a\n[b]: <https://example.com/b>\n\n[c]: https://example.com/c 'Third'\n\nAfter",
      ),
    ).toEqual([
      "See [one][a] and [two][b].\n\n[a]: https://example.com/a\n[b]: <https://example.com/b>\n\n[c]: https://example.com/c 'Third'",
      "After",
    ]);
  });

  it("recognizes every destination the renderer accepts, including escaped spaces", () => {
    expect(splitMarkdownBlocks("See [docs].\n\n[docs]: docs\\ folder/readme")).toEqual([
      "See [docs].\n\n[docs]: docs\\ folder/readme",
    ]);
    expect(splitMarkdownBlocks("See [docs].\n\n[docs]: <docs folder/readme> 'Title'")).toEqual([
      "See [docs].\n\n[docs]: <docs folder/readme> 'Title'",
    ]);
  });

  it("leaves a definition-only message as its own block", () => {
    expect(splitMarkdownBlocks("[d]: https://example.com")).toEqual(["[d]: https://example.com"]);
  });

  it("does not fold a paragraph that merely starts with a bracketed link", () => {
    expect(splitMarkdownBlocks("Intro\n\n[Link](https://example.com) and more prose")).toEqual([
      "Intro",
      "[Link](https://example.com) and more prose",
    ]);
  });

  it("treats triple newlines as a split point and filters empty blocks", () => {
    expect(splitMarkdownBlocks("First paragraph\n\n\nSecond paragraph")).toEqual([
      "First paragraph",
      "Second paragraph",
    ]);
  });
});
