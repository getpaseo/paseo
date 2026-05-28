import { describe, expect, it } from "vitest";
import {
  createMarkdownClipboardContent,
  type MarkdownClipboardEnvironment,
  type RichClipboardWriter,
  writeMarkdownToRichClipboard,
} from "./rich-clipboard";

interface RecordingClipboard {
  environment: MarkdownClipboardEnvironment;
  richWrites: Array<Record<"text/plain" | "text/html", Blob>>;
  plainTexts: string[];
}

function createRecordingClipboard(
  options: { supportsHtml?: boolean; richWriteFails?: boolean } = {},
): RecordingClipboard {
  const { supportsHtml = true, richWriteFails = false } = options;
  const richWrites: Array<Record<"text/plain" | "text/html", Blob>> = [];
  const plainTexts: string[] = [];

  const richWriter: RichClipboardWriter = {
    supportsHtml: () => supportsHtml,
    write: async (data) => {
      if (richWriteFails) {
        throw new Error("clipboard denied");
      }
      richWrites.push(data);
    },
  };

  const environment: MarkdownClipboardEnvironment = {
    richWriter,
    writePlainText: async (text) => {
      plainTexts.push(text);
    },
  };

  return { environment, richWrites, plainTexts };
}

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
    const clipboard = createRecordingClipboard();

    await writeMarkdownToRichClipboard("- item", clipboard.environment);

    const written = clipboard.richWrites[0];
    if (!written) {
      throw new Error("Expected rich clipboard data to be written");
    }
    await expect(written["text/plain"].text()).resolves.toBe("- item");
    await expect(written["text/html"].text()).resolves.toContain("<li>item</li>");
    expect(clipboard.plainTexts).toEqual([]);
  });

  it("falls back to plain text when rich clipboard writing fails", async () => {
    const clipboard = createRecordingClipboard({ richWriteFails: true });

    await writeMarkdownToRichClipboard("**bold**", clipboard.environment);

    expect(clipboard.plainTexts).toEqual(["**bold**"]);
    expect(clipboard.richWrites).toEqual([]);
  });
});
