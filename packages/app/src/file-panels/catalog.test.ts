import { describe, expect, it } from "vitest";
import { builtinFilePanels, isRenderedMarkdownFile } from "./catalog";
import { resolveFilePanel } from "./resolve";

function filePreviewRenderKind(path: string) {
  const { panel } = resolveFilePanel({
    file: { path, kind: "text", size: 100, hasBytes: false },
    candidates: builtinFilePanels,
    associations: {},
  });
  return panel ? panel.id.slice("builtin:".length) : null;
}

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

  it("returns null for files without a rendered preview", () => {
    expect(filePreviewRenderKind("src/index.ts")).toBe(null);
    expect(filePreviewRenderKind("page.mdx")).toBe(null);
    expect(filePreviewRenderKind("index.html.erb")).toBe(null);
  });
});

describe("built-in file panels", () => {
  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg"])(
    "registers the image extension %s",
    (extension) => {
      const resolution = resolveFilePanel({
        file: {
          path: `/capture.${extension.toUpperCase()}`,
          kind: "image",
          size: 512,
          hasBytes: true,
        },
        candidates: builtinFilePanels,
        associations: { [`ext:${extension}`]: "builtin:markdown" },
      });
      expect(resolution.panel?.id).toBe("builtin:image");
      expect(
        resolveFilePanel({
          file: { path: "capture.png", kind: "binary", size: 512, hasBytes: false },
          candidates: builtinFilePanels,
          associations: {},
        }).panel,
      ).toBeNull();
    },
  );

  it("does not impose a new preview size limit on built-in text panels", () => {
    expect(
      resolveFilePanel({
        file: { path: "notes.md", kind: "text", size: 11 * 1024 * 1024, hasBytes: false },
        candidates: builtinFilePanels,
        associations: {},
      }).panel?.id,
    ).toBe("builtin:markdown");
  });
});
