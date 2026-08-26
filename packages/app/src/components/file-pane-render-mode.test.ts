import { describe, expect, it } from "vitest";
import {
  filePreviewRenderKind,
  isRenderedMarkdownFile,
  isRenderedPdfFile,
} from "@/components/file-pane-render-mode";

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
    expect(filePreviewRenderKind("docs/guide.pdf")).toBe("pdf");
    expect(filePreviewRenderKind("docs/REFERENCE.PDF")).toBe("pdf");
  });

  it("returns null for files without a rendered preview", () => {
    expect(filePreviewRenderKind("src/index.ts")).toBe(null);
    expect(filePreviewRenderKind("page.mdx")).toBe(null);
    expect(filePreviewRenderKind("index.html.erb")).toBe(null);
    expect(filePreviewRenderKind("guide.pdf.txt")).toBe(null);
  });
});

describe("isRenderedPdfFile", () => {
  it("detects PDF files case-insensitively", () => {
    expect(isRenderedPdfFile("docs/guide.pdf")).toBe(true);
    expect(isRenderedPdfFile("docs/REFERENCE.PDF")).toBe(true);
  });

  it("does not treat files with a trailing extension as PDFs", () => {
    expect(isRenderedPdfFile("guide.pdf.txt")).toBe(false);
  });
});
