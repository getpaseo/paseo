import { describe, expect, it } from "vitest";
import { isRenderedMarkdownFile, resolveTextPreviewMode } from "@/components/file-pane-render-mode";

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
  });
});

describe("resolveTextPreviewMode", () => {
  it("renders markdown for markdown files", () => {
    expect(resolveTextPreviewMode("README.md")).toBe("markdown");
  });

  it("renders live html for html files", () => {
    expect(resolveTextPreviewMode("index.html")).toBe("html");
    expect(resolveTextPreviewMode("page.htm")).toBe("html");
  });

  it("renders source code for everything else", () => {
    expect(resolveTextPreviewMode("main.ts")).toBe("code");
    expect(resolveTextPreviewMode("Makefile")).toBe("code");
    // SVG is an image (handled by the image viewer), not an html text preview.
    expect(resolveTextPreviewMode("diagram.svg")).toBe("code");
    // .mdx is not rendered markdown.
    expect(resolveTextPreviewMode("page.mdx")).toBe("code");
  });

  it("forces source view when a specific line is targeted", () => {
    expect(resolveTextPreviewMode("index.html", { hasLineSelection: true })).toBe("code");
    expect(resolveTextPreviewMode("README.md", { hasLineSelection: true })).toBe("code");
  });
});
