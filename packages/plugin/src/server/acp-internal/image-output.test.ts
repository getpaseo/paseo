import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractToolCallContentImages,
  formatMarkdownImageSource,
  isLocalImageFilePath,
  renderAcpImageAsMarkdown,
  stripToolCallContentImages,
} from "./image-output.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

describe("ACP image output helpers", () => {
  it("materializes base64 images to a content-hashed temp file and emits file:// markdown", async () => {
    const markdown = await renderAcpImageAsMarkdown({
      data: ONE_BY_ONE_PNG_BASE64,
      mimeType: "image/png",
      altText: "Preview",
    });
    expect(markdown).toMatch(
      /^\n\n!\[Preview\]\(file:\/\/.*paseo-attachments-.*\/[0-9a-f]{64}\.png\)\n\n$/,
    );
    const match = markdown!.trim().match(/^!\[[^\]]*\]\((.*)\)$/);
    const filePath = fileURLToPath(match![1]!);
    try {
      expect(existsSync(filePath)).toBe(true);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it("extracts and strips image blocks from ACP tool call content", () => {
    const content = [
      { type: "content", content: { type: "text", text: "Screenshot captured" } },
      {
        type: "content",
        content: { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
      },
      {
        type: "content",
        content: {
          type: "resource",
          resource: {
            uri: "file:///tmp/shot.webp",
            mimeType: "image/webp",
            blob: ONE_BY_ONE_PNG_BASE64,
          },
        },
      },
    ];
    expect(extractToolCallContentImages(content)).toEqual([
      { data: ONE_BY_ONE_PNG_BASE64, url: null, mimeType: "image/png" },
      { data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/webp" },
    ]);
    const stripped = stripToolCallContentImages(content);
    expect(JSON.stringify(stripped)).not.toContain(ONE_BY_ONE_PNG_BASE64);
    expect(stripped).toEqual([
      { type: "content", content: { type: "text", text: "Screenshot captured" } },
      { type: "content", content: { type: "text", text: "[image]" } },
      { type: "content", content: { type: "text", text: "[image]" } },
    ]);
  });

  it("identifies local image paths and encodes POSIX and Windows file URIs", () => {
    expect(isLocalImageFilePath("/tmp/screenshot.png")).toBe(true);
    expect(isLocalImageFilePath("C:\\repo\\diagram.WEBP")).toBe(true);
    expect(isLocalImageFilePath("/tmp/notes.txt")).toBe(false);
    expect(isLocalImageFilePath("https://example.com/a.png")).toBe(false);
    expect(formatMarkdownImageSource("/tmp/my shot.png")).toBe("file:///tmp/my%20shot.png");
    expect(formatMarkdownImageSource("C:\\Users\\demo\\shot.png")).toBe(
      "file:///C:/Users/demo/shot.png",
    );
  });
});
