import { describe, expect, it } from "vitest";
import { groupMarkdownForNativeSelection, splitMarkdownBlocks } from "../split-markdown-blocks";

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

  it("treats triple newlines as a split point and filters empty blocks", () => {
    expect(splitMarkdownBlocks("First paragraph\n\n\nSecond paragraph")).toEqual([
      "First paragraph",
      "Second paragraph",
    ]);
  });
});

describe("groupMarkdownForNativeSelection", () => {
  it("keeps consecutive paragraphs in one prose group", () => {
    expect(groupMarkdownForNativeSelection("First paragraph\n\nSecond paragraph")).toEqual([
      { kind: "prose", text: "First paragraph\n\nSecond paragraph" },
    ]);
  });

  it("keeps a heading as its own group so paragraph selection stays a UITextView", () => {
    expect(
      groupMarkdownForNativeSelection("# Heading\n\nFirst paragraph\n\nSecond paragraph"),
    ).toEqual([
      { kind: "other", text: "# Heading" },
      { kind: "prose", text: "First paragraph\n\nSecond paragraph" },
    ]);
  });

  it("splits prose around a fenced code block", () => {
    expect(
      groupMarkdownForNativeSelection(
        "Intro paragraph\n\n```ts\nconst a = 1;\n```\n\nOutro paragraph",
      ),
    ).toEqual([
      { kind: "prose", text: "Intro paragraph" },
      { kind: "other", text: "```ts\nconst a = 1;\n```" },
      { kind: "prose", text: "Outro paragraph" },
    ]);
  });

  it("keeps indentation on a four-space code block", () => {
    expect(groupMarkdownForNativeSelection("Before\n\n    const value = 1\n\nAfter")).toEqual([
      { kind: "prose", text: "Before" },
      { kind: "other", text: "    const value = 1" },
      { kind: "prose", text: "After" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(groupMarkdownForNativeSelection("")).toEqual([]);
  });
});
