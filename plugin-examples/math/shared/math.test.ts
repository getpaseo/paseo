import { describe, expect, it } from "vitest";
import { hasMath, splitMathSegments } from "./math";

describe("math segments", () => {
  it("splits inline math out of a sentence", () => {
    expect(splitMathSegments("Hello $x^2$ world")).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "math", tex: "x^2", display: false },
      { kind: "text", text: " world" },
    ]);
  });

  it("splits display math, including multi-line", () => {
    expect(splitMathSegments("$$\\frac{a}{b}$$")).toEqual([
      { kind: "math", tex: "\\frac{a}{b}", display: true },
    ]);
    expect(splitMathSegments("$$\nline one\n\nline two\n$$")).toEqual([
      { kind: "math", tex: "line one\n\nline two", display: true },
    ]);
  });

  it("accepts the bracket and parenthesis aliases", () => {
    expect(splitMathSegments("\\( a+b \\)")[0]).toEqual({
      kind: "math",
      tex: "a+b",
      display: false,
    });
    expect(splitMathSegments("\\[ \\int_0^1 x dx \\]")[0]).toEqual({
      kind: "math",
      tex: "\\int_0^1 x dx",
      display: true,
    });
  });

  it("leaves currency as text", () => {
    expect(hasMath("预算 $20 到 $30 元")).toBe(false);
    expect(hasMath("| < $20 | 翻倍 |")).toBe(false);
  });

  it("ignores delimiters in code", () => {
    expect(hasMath("```ts\nconst a = $$x$$;\n```")).toBe(false);
    expect(hasMath("use `$x$` here")).toBe(false);
    expect(hasMath("~~~\n$$\n~~~")).toBe(false);
  });

  it("leaves escaped and unclosed delimiters as text", () => {
    expect(hasMath("cost \\$5 and \\$9")).toBe(false);
    expect(hasMath("$$ half")).toBe(false);
    expect(hasMath("an open $x stays text")).toBe(false);
  });

  it("keeps an escaped dollar inside a formula", () => {
    expect(splitMathSegments("$a + \\$ + b$")).toEqual([
      { kind: "math", tex: "a + \\$ + b", display: false },
    ]);
  });

  it("does not turn a streaming display opener into inline math", () => {
    expect(splitMathSegments("$$x$")).toEqual([{ kind: "text", text: "$$x$" }]);
  });

  it("closes a code span only on a run of the same length", () => {
    expect(splitMathSegments("``code ``` $x$``")).toEqual([
      { kind: "text", text: "``code ``` $x$``" },
    ]);
  });

  it("keeps formulas on later lines after a price list", () => {
    expect(splitMathSegments("$1 $2 $3\nlater $x$")).toEqual([
      { kind: "text", text: "$1 $2 $3\nlater " },
      { kind: "math", tex: "x", display: false },
    ]);
  });

  it("keeps the parenthesis alias working after a rejected dollar", () => {
    expect(splitMathSegments("cost $1 then \\(x\\)")).toEqual([
      { kind: "text", text: "cost $1 then " },
      { kind: "math", tex: "x", display: false },
    ]);
  });

  it("scans a price list once", () => {
    const prices = Array.from({ length: 200 }, (_, index) => `$${index + 1}`).join(" ");
    expect(hasMath(prices)).toBe(false);
  });

  it("requires a non-space character after the opening dollar", () => {
    expect(hasMath("$ x $")).toBe(false);
  });

  it("keeps the surrounding text in order", () => {
    const segments = splitMathSegments("a $b$ c $$d$$ e");
    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "math",
      "text",
      "math",
      "text",
    ]);
  });
});
