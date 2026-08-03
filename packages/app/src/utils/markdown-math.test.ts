import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { markdownMath } from "./markdown-math";

function getMathTokens(markdown: string) {
  const parser = MarkdownIt().use(markdownMath);
  const blockTokens = parser.parse(markdown, {});
  return blockTokens.flatMap((token) =>
    token.type === "inline" && token.children ? token.children : [token],
  );
}

describe("markdownMath", () => {
  it("parses inline and display formulas into dedicated tokens", () => {
    const tokens = getMathTokens("Energy is $E = mc^2$.\n\n$$\n\\int_0^1 x^2 dx\n$$");

    expect(
      tokens
        .filter((token) => token.type.startsWith("math_"))
        .map((token) => ({ type: token.type, content: token.content, markup: token.markup })),
    ).toEqual([
      { type: "math_inline", content: "E = mc^2", markup: "$" },
      { type: "math_block", content: "\\int_0^1 x^2 dx", markup: "$$" },
    ]);
  });
  it("supports parenthesis and bracket delimiters emitted by agents", () => {
    const tokens = getMathTokens("Inline \\(x^2\\).\n\n\\[\nE = mc^2\n\\]");

    expect(
      tokens
        .filter((token) => token.type.startsWith("math_"))
        .map((token) => ({ type: token.type, content: token.content, markup: token.markup })),
    ).toEqual([
      { type: "math_inline", content: "x^2", markup: "\\(" },
      { type: "math_block", content: "E = mc^2", markup: "\\[" },
    ]);
  });

  it("parses display delimiters embedded in prose", () => {
    const tokens = getMathTokens("Results: \\[x = 1\\], then $$y = 2$$.");

    expect(
      tokens
        .filter((token) => token.type.startsWith("math_"))
        .map((token) => ({ type: token.type, content: token.content, markup: token.markup })),
    ).toEqual([
      { type: "math_inline", content: "x = 1", markup: "\\[" },
      { type: "math_inline", content: "y = 2", markup: "$$" },
    ]);
  });

  it("keeps prose between punctuated same-line display formulas", () => {
    const tokens = getMathTokens("$$x$$.\n\ntext\n\n$$y$$");

    expect(
      tokens
        .filter((token) => token.type.startsWith("math_"))
        .map((token) => ({ type: token.type, content: token.content, markup: token.markup })),
    ).toEqual([
      { type: "math_inline", content: "x", markup: "$$" },
      { type: "math_block", content: "y", markup: "$$" },
    ]);
  });

  it("parses multiline display formulas with trailing closing-line content", () => {
    const tokens = getMathTokens("$$\nx\n$$.\n\n\\[\ny\n\\] and then");

    expect(
      tokens
        .filter((token) => token.type === "math_block" || token.type === "text")
        .map((token) => ({ type: token.type, content: token.content })),
    ).toEqual([
      { type: "math_block", content: "x" },
      { type: "text", content: "." },
      { type: "math_block", content: "y" },
      { type: "text", content: "and then" },
    ]);
  });

  it("ignores escaped display closers inside multiline formulas", () => {
    const tokens = getMathTokens(
      "$$\n\\$$ is literal\n\nstill math\n$$\n\n\\[\n\\\\] is literal\n\nstill math\n\\]",
    );

    expect(
      tokens.filter((token) => token.type === "math_block").map((token) => token.content),
    ).toEqual(["\\$$ is literal\n\nstill math", "\\\\] is literal\n\nstill math"]);
  });

  it("parses numeric-leading single-dollar formulas without treating prices as math", () => {
    const tokens = getMathTokens("$2x$ + $42$ + $2\\pi$; prices are $300 or $500.");

    expect(
      tokens.filter((token) => token.type.startsWith("math_")).map((token) => token.content),
    ).toEqual(["2x", "42", "2\\pi"]);
  });

  it("promotes fenced math to a display-math token", () => {
    const tokens = getMathTokens("```math\nx^2 + y^2 = z^2\n```");

    expect(
      tokens
        .filter((token) => token.type.startsWith("math_"))
        .map((token) => ({
          type: token.type,
          content: token.content,
          markup: token.markup,
          info: token.info,
        })),
    ).toEqual([
      {
        type: "math_block",
        content: "x^2 + y^2 = z^2\n",
        markup: "```",
        info: "math",
      },
    ]);
  });

  it("leaves currency, escaped delimiters, code, and incomplete formulas literal", () => {
    const tokens = getMathTokens(
      "Costs $300 or $500. Escaped: \\$x$. Code: `$x$`. Incomplete: $x + 1",
    );

    expect(tokens.filter((token) => token.type.startsWith("math_"))).toEqual([]);
  });
});
