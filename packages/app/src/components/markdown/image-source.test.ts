import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMarkdownSource } from "./source";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("preserves the host home directory for home-relative markdown paths", () => {
    expect(
      resolveMarkdownFileDirectory({
        markdownPath: "~/.paseo/plans/note.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("~/.paseo/plans");
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

  it("ignores local URL query strings and fragments", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "./images/hero.png?v=2#preview",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/workspace",
      }),
    ).toBe("/workspace/docs/images/hero.png");
  });

  it("preserves encoded filename characters when stripping URL suffixes", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "./hero%23draft%3Fv.png?v=2#preview",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/workspace",
      }),
    ).toBe("/workspace/docs/hero#draft?v.png");
  });

  it("preserves remote URL query strings and fragments", () => {
    const source = "https://example.com/hero.png?v=2#preview";
    expect(resolveMarkdownPreviewImageSource({ source, markdownPath: "docs/guide.md" })).toBe(
      source,
    );
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

  it("resolves images beside a home-relative document without using the workspace root", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "screenshots/output.png",
        markdownPath: "~/.paseo/plans/note.md",
        workspaceRoot: "/Users/test/project",
      }),
    ).toBe("~/.paseo/plans/screenshots/output.png");
  });

  it("decodes a file URI exactly once", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "file:///tmp/hero%2520image.png",
        markdownPath: "docs/guide.md",
        workspaceRoot: "/workspace",
      }),
    ).toBe("/tmp/hero%20image.png");
  });

  it("resolves parent segments from a home-relative document", () => {
    expect(
      resolveMarkdownPreviewImageSource({
        source: "../images/hero.png",
        markdownPath: "~/docs/guide.md",
        workspaceRoot: "/workspace",
      }),
    ).toBe("~/images/hero.png");
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

describe("local assistant Markdown images", () => {
  let workspaceRoot: string;
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "assistant-markdown-image-"));
    await mkdir(path.join(workspaceRoot, "My Apps", "Мои"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "My Apps", "Мои", "test.png"), imageBytes);
    await writeFile(path.join(workspaceRoot, "literal%20name.png"), imageBytes);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each([
    "absolute angle",
    "absolute encoded",
    "relative angle",
    "relative encoded",
    "file URI",
    "literal percent",
  ])("reads the actual image for the %s destination", async (form) => {
    const absolute = path.join(workspaceRoot, "My Apps", "Мои", "test.png");
    const destinations: Record<string, string> = {
      "absolute angle": `<${absolute}>`,
      "absolute encoded": encodeURI(absolute),
      "relative angle": "<My Apps/Мои/test.png>",
      "relative encoded": encodeURI("My Apps/Мои/test.png"),
      "file URI": `file://${encodeURI(absolute)}`,
      "literal percent": `${workspaceRoot}/literal%2520name.png`,
    };
    const prepared = prepareMarkdownSource(`![test](${destinations[form]})`);
    expect(prepared.images).toHaveLength(1);
    const source = resolveMarkdownPreviewImageSource({
      source: prepared.images[0]!.source,
      markdownPath: "",
      workspaceRoot,
    })!;
    const target = resolveAssistantImageSource({ source, workspaceRoot });
    expect(target?.kind).toBe("file_rpc");
    if (target?.kind !== "file_rpc") throw new Error("Expected a local image read target");
    await expect(readFile(path.resolve(target.cwd, target.path))).resolves.toEqual(imageBytes);
  });
});
