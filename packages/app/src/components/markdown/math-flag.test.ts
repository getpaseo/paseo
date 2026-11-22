import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { describe, expect, it } from "vitest";

/** Flags the renderer passes to the library; keep in sync with renderer.tsx. */
const MD4C_FLAGS = { latexMath: true, hardSoftBreaks: true, admonitions: true };

function nodeTypes(tree: ASTNode): string[] {
  const types: string[] = [];
  const walk = (node: ASTNode) => {
    types.push(node.type);
    node.children?.forEach(walk);
  };
  walk(tree);
  return types;
}

function collectMathContent(tree: ASTNode): string[] {
  const values: string[] = [];
  const walk = (node: ASTNode) => {
    if (node.type === "LatexMathInline" || node.type === "LatexMathDisplay") {
      values.push((node.children ?? []).map((child) => child.content ?? "").join(""));
      return;
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return values;
}

describe("markdown math flags", () => {
  it("parses inline and display LaTeX into math nodes", async () => {
    const tree = await parseMarkdown("Cost is $E = mc^2$.\n\n$$\\frac{a}{b} = c$$", MD4C_FLAGS);
    const types = nodeTypes(tree);
    expect(types).toContain("LatexMathInline");
    expect(types).toContain("LatexMathDisplay");
  });

  it("leaves currency as text", async () => {
    const tree = await parseMarkdown("Between $20 and $30 per day.", MD4C_FLAGS);
    expect(nodeTypes(tree)).not.toContain("LatexMathInline");
    expect(JSON.stringify(tree)).toContain("$20 and $30");
  });

  it("preserves table cells and restores pipes inside table math", async () => {
    const md = [
      "| Item | Header $|x|$ | Notes |",
      "| --- | --- | --- |",
      "| 1 | $|x| < 1$ and $\\Delta V|_{t_0}$ | **$|d_e^{\\rm core}|\\le 1$** |",
      "| 2 | $\\frac{4}{15|\\ln\\epsilon|}$ | $\\begin{array}{c|c}1&2\\end{array}$ |",
      "| 3 | $$|y|+1$$ | $\\|H\\|_{\\rm op}=0.7$ and $|z|$ |",
    ].join("\n");
    const tree = await parseMarkdown(md, MD4C_FLAGS);
    const table = tree.children?.[0];
    expect(table?.type).toBe("Table");
    const headRow = table?.children?.[0]?.children?.[0];
    const bodyRows = table?.children?.[1]?.children ?? [];
    expect(headRow?.children).toHaveLength(3);
    expect(bodyRows).toHaveLength(3);
    for (const row of bodyRows) {
      expect(row.children).toHaveLength(3);
    }
    expect(collectMathContent(tree)).toEqual([
      "|x|",
      "|x| < 1",
      "\\Delta V|_{t_0}",
      "|d_e^{\\rm core}|\\le 1",
      "\\frac{4}{15|\\ln\\epsilon|}",
      "\\begin{array}{c|c}1&2\\end{array}",
      "|y|+1",
      "\\|H\\|_{\\rm op}=0.7",
      "|z|",
    ]);
  });

  it("keeps escaped norms intact and does not confuse table currency with math pipes", async () => {
    const md = [
      "| Item | Amount | Formula |",
      "| --- | --- | --- |",
      "| A | $20 | $30 |",
      "| B | $20|30$ |",
      "| C | $20 | $\\|H\\|_{\\rm op}=0.7$ |",
      "| D | $\\|H\\|_{\\rm op}=0.7$ | $|x|$ |",
    ].join("\n");
    const tree = await parseMarkdown(md, MD4C_FLAGS);
    const bodyRows = tree.children?.[0]?.children?.[1]?.children ?? [];
    expect(bodyRows).toHaveLength(4);
    expect(JSON.stringify(bodyRows[0])).toContain("$20");
    expect(JSON.stringify(bodyRows[0])).toContain("$30");
    expect(collectMathContent(bodyRows[0]!)).toEqual([]);
    expect(bodyRows[1]?.children).toHaveLength(3);
    expect(JSON.stringify(bodyRows[1]?.children?.[1])).toContain("$20");
    expect(JSON.stringify(bodyRows[1]?.children?.[2])).toContain("30$");
    expect(collectMathContent(bodyRows[1]!)).toEqual([]);
    expect(JSON.stringify(bodyRows[2]?.children?.[1])).toContain("$20");
    expect(collectMathContent(bodyRows[2]!)).toEqual(["\\|H\\|_{\\rm op}=0.7"]);
    expect(collectMathContent(bodyRows[3]!)).toEqual(["\\|H\\|_{\\rm op}=0.7", "|x|"]);
  });

  it("parses math adjacent to CJK or Latin suffixes without breaking code or shell variables", async () => {
    const tree = await parseMarkdown(
      "对比 $\\Lambda$CDM 和 中文$x^2$中文；价格$20到$30，花了$20买了个$y$。\n\nRun $HOME/$USER and Outer$Inner$Leaf and `$|x|$`.\n\n```\n| a | $|x|$ |\n中文$x^2$中文\n```",
      MD4C_FLAGS,
    );
    expect(collectMathContent(tree)).toEqual(["\\Lambda", "x^2", "y"]);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain("CDM 和 中文");
    expect(serialized).toContain("价格$20到$30");
    expect(serialized).toContain("花了$20买了个");
    expect(serialized).toContain("$HOME/$USER");
    expect(serialized).toContain("Outer$Inner$Leaf");
    expect(serialized).not.toMatch(/[\uE000-\uE0FF]/);
  });
});
