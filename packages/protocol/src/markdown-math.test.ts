import { describe, expect, it } from "vitest";
import {
  classifyMathFlankChar,
  hasUnescapedDollar,
  isLikelyCurrencyOrProseSpan,
  matchMathAtDollar,
} from "./markdown-math.js";

describe("markdown-math shared delimiter policy", () => {
  it("distinguishes inline and display LaTeX math from prose currency and shell variables", () => {
    const inline = "阈值$\\theta \\in [0.5, 1.0]$时";
    expect(
      matchMathAtDollar({
        source: inline,
        pos: inline.indexOf("$"),
        blockEnd: inline.length,
        protectedRanges: [],
      }),
    ).toEqual({
      kind: "inline",
      openStart: 2,
      contentStart: 3,
      contentEnd: 24,
      closeEnd: 25,
    });

    const currency = "Costs $10 to $20 today";
    expect(
      matchMathAtDollar({
        source: currency,
        pos: currency.indexOf("$"),
        blockEnd: currency.length,
        protectedRanges: [],
      }),
    ).toEqual({
      kind: "literal",
      start: 6,
      end: 7,
      count: 1,
    });

    const display = "$$\n\\sum_{i=1}^n x_i\n$$";
    expect(
      matchMathAtDollar({
        source: display,
        pos: 0,
        blockEnd: display.length,
        protectedRanges: [],
      }),
    ).toEqual({
      kind: "display",
      openStart: 0,
      contentStart: 2,
      contentEnd: display.length - 2,
      closeEnd: display.length,
    });
  });

  it("classifies CJK flanks, escaped dollars, and currency prose spans consistently", () => {
    expect(classifyMathFlankChar("阈")).toBe("cjk");
    expect(classifyMathFlankChar("a")).toBe("word");
    expect(classifyMathFlankChar("(")).toBe("boundary");
    expect(hasUnescapedDollar(String.raw`\$10`)).toBe(false);
    expect(hasUnescapedDollar(String.raw`\\$x$`)).toBe(true);
    expect(isLikelyCurrencyOrProseSpan("10 to ")).toBe(true);
    expect(isLikelyCurrencyOrProseSpan("2^k")).toBe(false);
  });
});
