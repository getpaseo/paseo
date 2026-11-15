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
});
