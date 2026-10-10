import { afterEach, describe, expect, it } from "vitest";
import {
  clearMarkdownBlockDelimiters,
  getMarkdownBlockDelimiterRevision,
  getMarkdownBlockDelimiters,
  setMarkdownBlockDelimiters,
  splitMarkdownBlocks,
} from "../split-markdown-blocks";

const MATH_DELIMITERS = [
  { open: "$$", close: "$$" },
  { open: "\\[", close: "\\]" },
];
const math = { blockDelimiters: MATH_DELIMITERS };

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

  it("keeps display math with internal blank lines in one block", () => {
    expect(
      splitMarkdownBlocks(
        "Before\n\n$$\n\\begin{aligned}\na &= b\n\nc &= d\n\\end{aligned}\n$$\n\nAfter",
        math,
      ),
    ).toEqual(["Before", "$$\n\\begin{aligned}\na &= b\n\nc &= d\n\\end{aligned}\n$$", "After"]);
  });

  it("keeps bracket-delimited display math with internal blank lines in one block", () => {
    expect(splitMarkdownBlocks("Before\n\n\\[\na^2 + b^2\n\n= c^2\n\\]\n\nAfter", math)).toEqual([
      "Before",
      "\\[\na^2 + b^2\n\n= c^2\n\\]",
      "After",
    ]);
  });

  it("splits after a punctuated same-line display formula", () => {
    expect(splitMarkdownBlocks("$$x$$.\n\ntext\n\n$$y$$", math)).toEqual([
      "$$x$$.",
      "text",
      "$$y$$",
    ]);
  });

  it("splits after a multiline display formula with trailing content", () => {
    expect(
      splitMarkdownBlocks("$$\nx\n$$.\n\ntext\n\n\\[\ny\n\\] and then\n\nafter", math),
    ).toEqual(["$$\nx\n$$.", "text", "\\[\ny\n\\] and then", "after"]);
  });

  it("ignores escaped display delimiters on interior lines", () => {
    expect(
      splitMarkdownBlocks("Before\n\n$$\n\\$$ is literal\n\nstill math\n$$.\n\nAfter", math),
    ).toEqual(["Before", "$$\n\\$$ is literal\n\nstill math\n$$.", "After"]);
    expect(
      splitMarkdownBlocks(
        "Before\n\n\\[\n\\\\] is literal\n\nstill math\n\\] and then\n\nAfter",
        math,
      ),
    ).toEqual(["Before", "\\[\n\\\\] is literal\n\nstill math\n\\] and then", "After"]);
  });

  it("keeps an unclosed streamed display expression together", () => {
    expect(splitMarkdownBlocks("Before\n\n$$\na^2 + b^2\n\n= c^2", math)).toEqual([
      "Before",
      "$$\na^2 + b^2\n\n= c^2",
    ]);
  });

  it("keeps display math nested in a list together across blank lines", () => {
    expect(
      splitMarkdownBlocks(
        "Before\n\n- $$\n  \\begin{aligned}\n  a &= b\n\n  c &= d\n  \\end{aligned}\n  $$\n\nAfter",
        math,
      ),
    ).toEqual([
      "Before",
      "- $$\n  \\begin{aligned}\n  a &= b\n\n  c &= d\n  \\end{aligned}\n  $$",
      "After",
    ]);
  });

  it("keeps streamed display math nested in a blockquote together", () => {
    expect(splitMarkdownBlocks("Before\n\n> \\[\n> a^2 + b^2\n\n> = c^2", math)).toEqual([
      "Before",
      "> \\[\n> a^2 + b^2\n\n> = c^2",
    ]);
  });

  // Agents show LaTeX source in fenced blocks, so an opener inside a fence must not arm
  // protection for the rest of the message. Fence tracking is what stops that; markdown-it's
  // own token pass already keeps the fence's interior blank lines together.
  it("does not let an opener inside a code fence open protection", () => {
    expect(splitMarkdownBlocks("Source:\n\n```latex\n$$\nx^2\n```\n\nOne\n\nTwo", math)).toEqual([
      "Source:",
      "```latex\n$$\nx^2\n```",
      "One",
      "Two",
    ]);
  });

  it("does not let an opener inside a blockquoted fence open protection", () => {
    expect(
      splitMarkdownBlocks("> ```\n> :::\n> ```\n\nOne\n\nTwo", {
        blockDelimiters: [{ open: ":::", close: ":::" }],
      }),
    ).toEqual(["> ```\n> :::\n> ```", "One", "Two"]);
  });

  it("does not close a fence when the marker is followed by non-space text", () => {
    expect(splitMarkdownBlocks("```\ncode\n```still\n```\n\nAfter\n\nDone")).toEqual([
      "```\ncode\n```still\n```",
      "After",
      "Done",
    ]);
  });

  it("does not protect a pair that no extension declared", () => {
    expect(splitMarkdownBlocks("Before\n\n$$\na\n\nb\n$$")).toEqual(["Before", "$$\na", "b\n$$"]);
  });

  it("prefers the longest matching opener so $$ is not read as $", () => {
    const delimiters = [
      { open: "$", close: "$" },
      { open: "$$", close: "$$" },
    ];
    expect(splitMarkdownBlocks("$$\na\n\nb\n$$", { blockDelimiters: delimiters })).toEqual([
      "$$\na\n\nb\n$$",
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

  it("does not fold a delimiter-protected region that parses as link reference definitions", () => {
    expect(
      splitMarkdownBlocks("Before\n\n[d]: https://open\n\n[e]: https://close\n\nAfter", {
        blockDelimiters: [{ open: "[d]:", close: "[e]:" }],
      }),
    ).toEqual(["Before", "[d]: https://open\n\n[e]: https://close", "After"]);
  });

  it("keeps a leading delimiter-protected definition-only region separate from following prose", () => {
    expect(
      splitMarkdownBlocks("[d]: https://open\n\n[e]: https://close\n\nAfter", {
        blockDelimiters: [{ open: "[d]:", close: "[e]:" }],
      }),
    ).toEqual(["[d]: https://open\n\n[e]: https://close", "After"]);
  });

  it("does not glue a leading definition-only block into a delimiter-protected region", () => {
    expect(
      splitMarkdownBlocks(
        "See [docs][d].\n\n[d]: https://example.com\n\n[k]: https://open\n\n[l]: https://close\n\nAfter",
        { blockDelimiters: [{ open: "[k]:", close: "[l]:" }] },
      ),
    ).toEqual([
      "See [docs][d].\n\n[d]: https://example.com",
      "[k]: https://open\n\n[l]: https://close",
      "After",
    ]);
  });

  it("treats triple newlines as a split point and filters empty blocks", () => {
    expect(splitMarkdownBlocks("First paragraph\n\n\nSecond paragraph")).toEqual([
      "First paragraph",
      "Second paragraph",
    ]);
  });
});

describe("setMarkdownBlockDelimiters", () => {
  afterEach(() => {
    clearMarkdownBlockDelimiters();
  });

  it("bumps the catalog revision on publish and clear", () => {
    const before = getMarkdownBlockDelimiterRevision();
    setMarkdownBlockDelimiters("host-rev", MATH_DELIMITERS);
    expect(getMarkdownBlockDelimiterRevision()).toBeGreaterThan(before);
    clearMarkdownBlockDelimiters("host-rev");
    expect(getMarkdownBlockDelimiterRevision()).toBeGreaterThan(before + 1);
  });

  it("scopes registered delimiters to the host they were published for", () => {
    setMarkdownBlockDelimiters("host-a", MATH_DELIMITERS);
    expect(getMarkdownBlockDelimiters("host-a")).toEqual(MATH_DELIMITERS);
    expect(getMarkdownBlockDelimiters("host-b")).toEqual([]);
    expect(splitMarkdownBlocks("Before\n\n$$\na\n\nb\n$$", { serverId: "host-a" })).toEqual([
      "Before",
      "$$\na\n\nb\n$$",
    ]);
    expect(splitMarkdownBlocks("Before\n\n$$\na\n\nb\n$$", { serverId: "host-b" })).toEqual([
      "Before",
      "$$\na",
      "b\n$$",
    ]);
  });

  it("clears protection for a host when set back to an empty list", () => {
    setMarkdownBlockDelimiters("host-a", MATH_DELIMITERS);
    setMarkdownBlockDelimiters("host-a", []);
    expect(splitMarkdownBlocks("$$\na\n\nb\n$$", { serverId: "host-a" })).toEqual([
      "$$\na",
      "b\n$$",
    ]);
  });

  it("closes a ::: pair when an unescaped close appears anywhere on a line", () => {
    expect(
      splitMarkdownBlocks(":::\ntext ::: literal\n\nstill inside\n:::", {
        blockDelimiters: [{ open: ":::", close: ":::" }],
      }),
    ).toEqual([":::\ntext ::: literal", "still inside\n:::"]);
  });
});
