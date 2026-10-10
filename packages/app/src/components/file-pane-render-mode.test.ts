import { describe, expect, it } from "vitest";
import { filePreviewRenderKind, isRenderedMarkdownFile } from "@/components/file-pane-render-mode";

describe("isRenderedMarkdownFile", () => {
  it("detects .md files", () => {
    expect(isRenderedMarkdownFile("README.md")).toBe(true);
    expect(isRenderedMarkdownFile("docs/guide.MD")).toBe(true);
  });

  it("detects .markdown files", () => {
    expect(isRenderedMarkdownFile("notes.markdown")).toBe(true);
    expect(isRenderedMarkdownFile("docs/CHANGELOG.MARKDOWN")).toBe(true);
  });

  it("does not treat .mdx files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("page.mdx")).toBe(false);
  });

  it("does not treat other text files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("src/index.ts")).toBe(false);
    expect(isRenderedMarkdownFile("README.md.txt")).toBe(false);
    expect(isRenderedMarkdownFile("plan.html")).toBe(false);
  });
});

describe("filePreviewRenderKind", () => {
  it("maps each renderable extension to its kind", () => {
    expect(filePreviewRenderKind("README.md")).toBe("markdown");
    expect(filePreviewRenderKind("notes.markdown")).toBe("markdown");
    expect(filePreviewRenderKind("plan.html")).toBe("html");
    expect(filePreviewRenderKind("docs/PLAN.HTML")).toBe("html");
    expect(filePreviewRenderKind("plan.htm")).toBe("html");
  });

  it("classifies the reported long-document shape as too large for preview", () => {
    const source = Array.from({ length: 3320 }, (_, i) => `Paragraph ${i}: ${"x".repeat(40)}`).join(
      "\n",
    );
    expect(filePreviewRenderKind("notes.md", source)).toBe("markdown-too-large");
  });

  it("bounds characters independently of line count", () => {
    expect(filePreviewRenderKind("notes.md", "x".repeat(64 * 1024))).toBe("markdown");
    expect(filePreviewRenderKind("notes.md", "x".repeat(64 * 1024 + 1))).toBe("markdown-too-large");
  });

  it("bounds many short lines independently of character count", () => {
    expect(filePreviewRenderKind("notes.md", "x\n".repeat(999))).toBe("markdown");
    expect(filePreviewRenderKind("notes.md", "x\n".repeat(1000))).toBe("markdown-too-large");
    expect(filePreviewRenderKind("notes.MARKDOWN", "x\r\n".repeat(1000))).toBe(
      "markdown-too-large",
    );
    expect(filePreviewRenderKind("notes.md", "x\r".repeat(1000))).toBe("markdown-too-large");
  });

  it("preserves empty Markdown, HTML, and source-file behavior", () => {
    expect(filePreviewRenderKind("notes.md", "")).toBe("markdown");
    expect(filePreviewRenderKind("notes.html", "x".repeat(100_000))).toBe("html");
    expect(filePreviewRenderKind("notes.txt", "x".repeat(100_000))).toBe(null);
  });

  it("returns null for files without a rendered preview", () => {
    expect(filePreviewRenderKind("src/index.ts")).toBe(null);
    expect(filePreviewRenderKind("page.mdx")).toBe(null);
    expect(filePreviewRenderKind("index.html.erb")).toBe(null);
  });
});
