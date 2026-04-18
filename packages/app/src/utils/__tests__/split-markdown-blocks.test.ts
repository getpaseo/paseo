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

  it("treats triple newlines as a split point and filters empty blocks", () => {
    expect(splitMarkdownBlocks("First paragraph\n\n\nSecond paragraph")).toEqual([
      "First paragraph",
      "Second paragraph",
    ]);
  });
});
