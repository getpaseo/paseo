import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { describe, expect, it } from "vitest";
import { prepareMarkdownSource } from "./source";

/** Flags the renderer passes to the library; keep in sync with renderer.tsx. */
const MD4C_FLAGS = { latexMath: true, hardSoftBreaks: true, admonitions: true };

// A Codex reply about camera calibration, as it reached the chat.
const CALIBRATION = String.raw`棋盘角点的已知坐标为 \(P_j=(js,ks,0)\)，其中 \(s\) 是实测格长。第 \(i\) 帧的成像关系为：

\[
p_{ij}=\pi(K,D,\ R_iP_j+t_i)
\]

其中：

- \(p_{ij}\)：图像上检测到的角点像素；
- \(K\)：内参矩阵；\(D\)：畸变系数；

\[
K=
\begin{bmatrix}
f_x&0&c_x\\
0&f_y&c_y\\
0&0&1
\end{bmatrix}
\]`;

const render = (source: string) => prepareMarkdownSource(source).render();

function mathNodes(tree: ASTNode): { type: string; tex: string }[] {
  const found: { type: string; tex: string }[] = [];
  const text = (node: ASTNode): string =>
    (node.content ?? "") + (node.children ?? []).map(text).join("");
  const walk = (node: ASTNode) => {
    if (node.type === "LatexMathInline" || node.type === "LatexMathDisplay") {
      found.push({ type: node.type, tex: text(node).trim() });
      return;
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return found;
}

describe("TeX delimiters", () => {
  it("rewrites \\( \\) and \\[ \\] to the dollar delimiters md4c parses", () => {
    expect(render(String.raw`Let \(x^2\) be \[\frac{a}{b}\] here.`)).toBe(
      String.raw`Let $x^2$ be $$\frac{a}{b}$$ here.`,
    );
  });

  it("renders a calibration reply's inline and display formulas as math", async () => {
    const tree = await parseMarkdown(prepareMarkdownSource(CALIBRATION).render(), MD4C_FLAGS);
    const math = mathNodes(tree);
    expect(math.filter((node) => node.type === "LatexMathInline").map((node) => node.tex)).toEqual([
      "P_j=(js,ks,0)",
      "s",
      "i",
      "p_{ij}",
      "K",
      "D",
    ]);
    const display = math.filter((node) => node.type === "LatexMathDisplay");
    expect(display).toHaveLength(2);
    expect(display[0].tex).toBe(String.raw`p_{ij}=\pi(K,D,\ R_iP_j+t_i)`);
    // Row breaks keep both backslashes; Markdown escapes would have eaten one.
    expect(display[1].tex).toContain(String.raw`f_x&0&c_x\\`);
    expect(display[1].tex).toContain(String.raw`\end{bmatrix}`);
  });

  it("leaves code spans, fences and escaped backslashes alone", () => {
    const source = [
      "Use `\\(x\\)` in a regex.",
      "",
      "```tex",
      "\\[ a \\]",
      "```",
      "",
      "A literal \\\\(not math\\\\) stays.",
    ].join("\n");
    expect(render(source)).toBe(source);
  });

  it("pairs delimiters only inside one paragraph and skips unmatched ones", () => {
    const source = "Opens \\( here\n\nand closes \\) there. A lone \\] too.";
    expect(render(source)).toBe(source);
  });

  it("pads a delimiter only where md4c would not open or close it", () => {
    expect(render(String.raw`为\(x\)的`)).toBe("为 $x$ 的");
    expect(render(String.raw`（\(x\)，\(y\)）`)).toBe("（$x$，$y$）");
    expect(render(String.raw`\(a\)\(b\)`)).toBe("$a$ $b$");
  });

  it("keeps bars and entities inside math out of the prose rewrites", async () => {
    expect(render(String.raw`Norm \(||x||_2\) and $||y||_1$, spoiler ||hidden||, A &amp; B`)).toBe(
      String.raw`Norm $||x||_2$ and $||y||_1$, spoiler \|\|hidden\|\|, A \& B`,
    );
    const math = mathNodes(
      await parseMarkdown(render(String.raw`Norm \(||x||_2\) here.`), MD4C_FLAGS),
    );
    expect(math).toEqual([{ type: "LatexMathInline", tex: "||x||_2" }]);
  });

  it("keeps currency and shell variables in prose as text", async () => {
    const source = String.raw`Costs $20 to $30; run $HOME/bin with \(n\) workers.`;
    const math = mathNodes(await parseMarkdown(prepareMarkdownSource(source).render(), MD4C_FLAGS));
    expect(math).toEqual([{ type: "LatexMathInline", tex: "n" }]);
  });
});
