import { describe, expect, it } from "vitest";
import { getFileExtension, isAutoPreviewHtml, resolveFilePreviewKind } from "./preview-kind";

describe("getFileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(getFileExtension("index.HTML")).toBe("html");
    expect(getFileExtension("a/b/c/report.Md")).toBe("md");
  });

  it("returns empty for extensionless files and dotfiles", () => {
    expect(getFileExtension("Makefile")).toBe("");
    expect(getFileExtension(".gitignore")).toBe("");
    expect(getFileExtension("/a/b/LICENSE")).toBe("");
  });
});

describe("resolveFilePreviewKind", () => {
  it("treats html variants as html", () => {
    expect(resolveFilePreviewKind("index.html")).toBe("html");
    expect(resolveFilePreviewKind("page.htm")).toBe("html");
    expect(resolveFilePreviewKind("doc.xhtml")).toBe("html");
    expect(resolveFilePreviewKind("/abs/path/Report.HTML")).toBe("html");
  });

  it("classifies images (incl. svg), markdown, pdf, and text", () => {
    // SVG is served as an image by the server; the classifier stays aligned.
    expect(resolveFilePreviewKind("icon.svg")).toBe("image");
    expect(resolveFilePreviewKind("photo.PNG")).toBe("image");
    expect(resolveFilePreviewKind("notes.md")).toBe("markdown");
    // .mdx is not rendered markdown (matches isRenderedMarkdownFile).
    expect(resolveFilePreviewKind("page.mdx")).toBe("text");
    expect(resolveFilePreviewKind("paper.pdf")).toBe("pdf");
    expect(resolveFilePreviewKind("main.ts")).toBe("text");
    expect(resolveFilePreviewKind("Makefile")).toBe("text");
  });
});

describe("isAutoPreviewHtml", () => {
  it("is true for html only, false otherwise", () => {
    expect(isAutoPreviewHtml("/tmp/out.html")).toBe(true);
    expect(isAutoPreviewHtml("page.htm")).toBe(true);
    // SVG is an image (server-served as such), not an html auto-preview.
    expect(isAutoPreviewHtml("diagram.svg")).toBe(false);
    expect(isAutoPreviewHtml("readme.md")).toBe(false);
    expect(isAutoPreviewHtml("app.tsx")).toBe(false);
    expect(isAutoPreviewHtml("photo.png")).toBe(false);
  });
});
