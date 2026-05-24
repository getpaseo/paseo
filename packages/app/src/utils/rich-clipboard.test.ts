import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownClipboardContent,
  type RichClipboardWriter,
  writeMarkdownToRichClipboard,
} from "./rich-clipboard";

const { setStringAsyncMock } = vi.hoisted(() => ({
  setStringAsyncMock: vi.fn(async () => true),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: setStringAsyncMock,
}));

beforeEach(() => {
  setStringAsyncMock.mockClear();
});

describe("createMarkdownClipboardContent", () => {
  it("renders markdown structures to clipboard html", () => {
    const markdown = [
      "# Heading",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| One | Two |",
      "",
      "- Parent",
      "  - Child",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    const content = createMarkdownClipboardContent(markdown);

    expect(content.plainText).toBe(markdown);
    expect(content.html).toContain("<h1>Heading</h1>");
    expect(content.html).toContain("<table>");
    expect(content.html).toContain("<ul>");
    expect(content.html).toContain('class="language-ts"');
  });

  it("escapes raw html instead of placing it on the rich clipboard", () => {
    const content = createMarkdownClipboardContent(
      '<script>alert("x")</script>\n\n[jump](javascript:alert("x"))',
    );

    expect(content.html).not.toContain("<script>");
    expect(content.html).not.toContain('href="javascript:');
    expect(content.html).toContain("&lt;script&gt;");
  });
});

describe("writeMarkdownToRichClipboard", () => {
  it("writes plain text and html when a rich clipboard writer is available", async () => {
    const markdown = "- item";
    const writes: Array<Parameters<RichClipboardWriter["write"]>[0]> = [];
    const richWriter: RichClipboardWriter = {
      supportsHtml: () => true,
      write: async (data) => {
        writes.push(data);
      },
    };

    await writeMarkdownToRichClipboard(markdown, {
      richWriter,
      writePlainText: setStringAsyncMock,
    });

    const written = writes[0];
    if (!written) {
      throw new Error("Expected rich clipboard data to be written");
    }
    await expect(written["text/plain"].text()).resolves.toBe(markdown);
    await expect(written["text/html"].text()).resolves.toContain("<li>item</li>");
    expect(setStringAsyncMock).not.toHaveBeenCalled();
  });

  it("falls back to plain text when rich clipboard writing fails", async () => {
    const richWriter: RichClipboardWriter = {
      supportsHtml: () => true,
      write: async () => {
        throw new Error("clipboard denied");
      },
    };

    await writeMarkdownToRichClipboard("**bold**", {
      richWriter,
      writePlainText: setStringAsyncMock,
    });

    expect(setStringAsyncMock).toHaveBeenCalledWith("**bold**");
  });
});
