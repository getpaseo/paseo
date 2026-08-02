import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import {
  installMarkdownFenceMetadata,
  isClosedFenceMetadata,
  isMermaidFenceInfo,
} from "./markdown-fence";

function parseFence(source: string) {
  const parser = MarkdownIt();
  installMarkdownFenceMetadata(parser);
  return parser.parse(source, {}).find((token) => token.type === "fence");
}

describe("Mermaid fence detection", () => {
  it("recognizes Mermaid as the first normalized fence info token", () => {
    expect([
      isMermaidFenceInfo("mermaid"),
      isMermaidFenceInfo("MERMAID"),
      isMermaidFenceInfo(".mermaid {1,3}"),
    ]).toEqual([true, true, true]);
  });

  it("does not infer Mermaid from another language or unlabeled source", () => {
    expect([
      isMermaidFenceInfo("typescript"),
      isMermaidFenceInfo("diagram"),
      isMermaidFenceInfo(null),
    ]).toEqual([false, false, false]);
  });
});

describe("Markdown fence completion", () => {
  it("marks matching backtick and tilde fences as closed", () => {
    const backtick = parseFence("```mermaid\ngraph TD\nA --> B\n```");
    const tilde = parseFence("~~~~mermaid\ngraph TD\nA --> B\n~~~~~");

    expect([isClosedFenceMetadata(backtick?.meta), isClosedFenceMetadata(tilde?.meta)]).toEqual([
      true,
      true,
    ]);
  });

  it("keeps an unfinished streaming fence open", () => {
    const token = parseFence("```mermaid\ngraph TD\nA --> B");
    expect(isClosedFenceMetadata(token?.meta)).toBe(false);
  });

  it("does not accept a shorter or different closing delimiter", () => {
    const shorter = parseFence("````mermaid\ngraph TD\nA --> B\n```");
    const different = parseFence("```mermaid\ngraph TD\nA --> B\n~~~");

    expect([isClosedFenceMetadata(shorter?.meta), isClosedFenceMetadata(different?.meta)]).toEqual([
      false,
      false,
    ]);
  });
});
