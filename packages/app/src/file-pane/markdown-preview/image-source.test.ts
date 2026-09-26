import { describe, expect, it } from "vitest";

import { resolveMarkdownFileDirectory, resolveMarkdownPreviewImageSource } from "./image-source";

describe("resolveMarkdownFileDirectory", () => {
  it("uses the parent of an absolute markdown path", () => {
    expect(
      resolveMarkdownFileDirectory({
        markdownPath: "/Users/test/project/docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/Users/test/project/docs");
  });

  it("joins a workspace-relative markdown path to the workspace root", () => {
    expect(
      resolveMarkdownFileDirectory({
        markdownPath: "docs/星谷云/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/Users/test/project/docs/星谷云");
  });

  it("returns null for home-relative markdown paths", () => {
    expect(
      resolveMarkdownFileDirectory({
        markdownPath: "~/.paseo/plans/note.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBeNull();
  });
});

describe("resolveMarkdownPreviewImageSource", () => {
  it("passes through remote and data URIs", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "https://example.com/image.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("https://example.com/image.png");
    expect(
      resolveMarkdownPreviewImageSource({
        source: "data:image/png;base64,abc",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("data:image/png;base64,abc");
  });

  it("resolves a sibling image against the markdown file", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "./images/hero.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/Users/test/project/docs/images/hero.png");
  });

  it("resolves parent-relative images that stay inside the workspace", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "../../data/cache/xinggu_docs/12-linkedin/token.png",
        markdownPath: "docs/星谷云/12-LinkedIn.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/Users/test/project/data/cache/xinggu_docs/12-linkedin/token.png");
  });

  it("keeps absolute and home-relative image paths", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "/tmp/screenshot.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/tmp/screenshot.png");
    expect(
      resolveMarkdownPreviewImageSource({
        source: "~/.paseo/screenshots/output.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("~/.paseo/screenshots/output.png");
  });

  it("normalizes file URIs into host paths", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "file:///tmp/paseo-preview.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("/tmp/paseo-preview.png");
  });

  it("falls back to the raw relative path when the markdown directory is unknown", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "screenshots/output.png",
        markdownPath: "~/.paseo/plans/note.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("screenshots/output.png");
  });

  it("resolves Windows relative images against a drive-rooted markdown file", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "..\\images\\hero.png",
        markdownPath: "C:\\Users\\test\\repo\\docs\\guide.md",
        workspaceRoot: "C:\\Users\\test\\repo",
      }),
    ).toBe("C:/Users/test/repo/images/hero.png");
  });
});
