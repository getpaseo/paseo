import { renderToString } from "katex";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { extractNodeText } from "react-native-enriched-markdown/src/web/utils";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { prepareMarkdownSource } from "./source";
import { createMarkdownStyles } from "./styles";

const WEB_MATH_FLAGS = { latexMath: true, hardSoftBreaks: true, admonitions: true };
const BASE_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };

interface ParsedMathSpan {
  type: "LatexMathInline" | "LatexMathDisplay";
  content: string;
}

async function parseWebMarkdown(source: string) {
  const prepared = prepareMarkdownSource(source, undefined, {
    supportsSvg: true,
    latexMath: true,
  });
  const rendered = prepared.render();
  const flags = prepared.hasLatexMath ? WEB_MATH_FLAGS : BASE_FLAGS;
  const ast = await parseMarkdown(rendered, flags);
  const mathSpans: ParsedMathSpan[] = [];
  let plainText = "";

  function walk(node: ASTNode) {
    if (node.type === "LatexMathInline" || node.type === "LatexMathDisplay") {
      mathSpans.push({ type: node.type, content: extractNodeText(node) });
      return;
    }
    if (node.type === "Text" || node.type === "Code") {
      plainText += node.content ?? "";
    }
    node.children?.forEach(walk);
  }

  walk(ast);
  return { rendered, ast, mathSpans, plainText, enabledLatexFlag: flags.latexMath };
}

describe("Markdown LaTeX math adaptation and currency protection", () => {
  it("parses inline math across Chinese technical prose and bold spans and renders valid MathML", async () => {
    const source =
      "只在 $2^k$ 翻倍点建 Key 后，单请求全量写最多 16 个 Key（20 万 token 约 12 个 Key）。更关键的是：当亲和阈值 $\\theta \\in [0.5, 1.0]$（默认 0.80）时，读区间 $[\\text{floorLevel}(\\theta N_w), N_w]$ 的上下界比值不超过 2，因此**ReadSet 在数学上永远 $\\le 2$ 个 Key**，无论上下文多长都只需 1 次 Pipeline RTT。";

    const result = await parseWebMarkdown(source);
    expect(result.enabledLatexFlag).toBe(true);
    expect(result.mathSpans).toEqual([
      { type: "LatexMathInline", content: "2^k" },
      { type: "LatexMathInline", content: "\\theta \\in [0.5, 1.0]" },
      { type: "LatexMathInline", content: "[\\text{floorLevel}(\\theta N_w), N_w]" },
      { type: "LatexMathInline", content: "\\le 2" },
    ]);

    for (const span of result.mathSpans) {
      const mathml = renderToString(span.content, {
        output: "mathml",
        displayMode: false,
        throwOnError: true,
        trust: false,
      });
      expect(mathml).toContain("<math");
    }
  });

  it("supports inline math directly adjacent to CJK characters without spaces", async () => {
    const result = await parseWebMarkdown("当阈值$\\theta=0.8$时，复杂度为$O(n\\log n)$。");
    expect(result.mathSpans).toEqual([
      { type: "LatexMathInline", content: "\\theta=0.8" },
      { type: "LatexMathInline", content: "O(n\\log n)" },
    ]);
  });

  it("preserves multiline display math, aligned environments, norms, and escaped dollars inside math", async () => {
    const source = [
      "Norm $||x||_2$ and price $\\text{cost} = \\$5$ with spoiler ||hidden|| &amp; text:",
      "",
      "$$",
      "\\begin{aligned}",
      "\\text{ReadSet} &= \\{ 2^k \\mid \\theta N_w \\le 2^k \\le N_w \\} \\\\",
      "|\\text{ReadSet}| &\\le 2",
      "\\end{aligned}",
      "$$",
    ].join("\n");

    const result = await parseWebMarkdown(source);
    expect(result.mathSpans).toHaveLength(3);
    expect(result.mathSpans[0]).toEqual({ type: "LatexMathInline", content: "||x||_2" });
    expect(result.mathSpans[1]).toEqual({
      type: "LatexMathInline",
      content: "\\text{cost} = \\$5",
    });
    expect(result.mathSpans[2]?.type).toBe("LatexMathDisplay");
    expect(result.mathSpans[2]?.content).toContain("\\begin{aligned}");
    expect(result.plainText).toContain("||hidden|| & text:");

    const displayMathml = renderToString(result.mathSpans[2]!.content, {
      output: "mathml",
      displayMode: true,
      throwOnError: true,
      trust: false,
    });
    expect(displayMathml).toContain(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">',
    );
    expect(displayMathml).toContain("<mtable");
  });

  it.each([
    ["simple currency range", "Costs $50 to $100.", "Costs $50 to $100."],
    ["hyphenated currency range", "Costs $50-$100 or $10/$20.", "Costs $50-$100 or $10/$20."],
    ["decimal cents currency", "Costs $50 to $.99.", "Costs $50 to $.99."],
    ["spaced dollar currency", "Price: $ 50 to $ 100.", "Price: $ 50 to $ 100."],
    ["leading and trailing dollar prose", "From $10 to 20$.", "From $10 to 20$."],
    ["parenthesized trailing dollar", "Cost is $50 (or 40$).", "Cost is $50 (or 40$)."],
    ["Chinese currency prose", "预算从 $10 到 20$ 美元。", "预算从 $10 到 20$ 美元。"],
    [
      "currency symbol in parens",
      "Amounts in USD ($) or CAD ($).",
      "Amounts in USD ($) or CAD ($).",
    ],
    [
      "shell variables",
      "Shell vars $HOME and $? in $PATH:$HOME.",
      "Shell vars $HOME and $? in $PATH:$HOME.",
    ],
  ])(
    "does not misclassify %s as math and skips KaTeX flag",
    async (_label, source, expectedText) => {
      const result = await parseWebMarkdown(source);
      expect(result.enabledLatexFlag).toBe(false);
      expect(result.mathSpans).toEqual([]);
      expect(result.plainText).toBe(expectedText);
    },
  );

  it("keeps prose currency literal on the same line as real inline math", async () => {
    const source = "The plan costs $20/mo, so for $(n + 1)$ users it is $20(n+1)$.";
    const result = await parseWebMarkdown(source);

    expect(result.enabledLatexFlag).toBe(true);
    expect(result.mathSpans).toEqual([
      { type: "LatexMathInline", content: "(n + 1)" },
      { type: "LatexMathInline", content: "20(n+1)" },
    ]);
    expect(result.plainText).toBe("The plan costs $20/mo, so for  users it is .");
  });

  it("never alters dollars inside inline code, code fences, or URLs", async () => {
    const source = [
      "Inline `$x + y$` and `echo $HOME` and [API](https://example.com/$v1/$users) and https://example.com/$raw$/path.",
      "",
      "```sh",
      "echo $HOME $1 $$",
      "```",
    ].join("\n");

    const result = await parseWebMarkdown(source);

    expect(result.rendered).toBe(source);
    expect(result.enabledLatexFlag).toBe(false);
    expect(result.mathSpans).toEqual([]);
  });

  it("themes display and inline math colors for both dark and light modes", () => {
    const dark = createMarkdownStyles(darkTheme, { blockGap: 12 }).markdownStyle;
    const light = createMarkdownStyles(lightTheme, { blockGap: 12 }).markdownStyle;

    expect(dark.inlineMath?.color).toBe(darkTheme.colors.foreground);
    expect(dark.math?.color).toBe(darkTheme.colors.foreground);
    expect(dark.math?.backgroundColor).toBe(darkTheme.colors.surface1);

    expect(light.inlineMath?.color).toBe(lightTheme.colors.foreground);
    expect(light.math?.color).toBe(lightTheme.colors.foreground);
    expect(light.math?.backgroundColor).toBe(lightTheme.colors.surface1);
  });
});
