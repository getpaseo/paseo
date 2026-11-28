import { describe, expect, it } from "vitest";
import {
  createCodeClipboardContent,
  createMarkdownClipboardContent,
  createSelectionClipboardContent,
  type MarkdownClipboardEnvironment,
  type RichClipboardWriter,
  writeClipboardContent,
  writeMarkdownToRichClipboard,
} from "./rich-clipboard";

interface RecordingClipboard {
  environment: MarkdownClipboardEnvironment;
  richWrites: Array<Record<"text/plain" | "text/html", Blob>>;
  plainTexts: string[];
}

function createRecordingClipboard(
  options: { supportsHtml?: boolean; richWriteFails?: boolean; plainWriteResult?: unknown } = {},
): RecordingClipboard {
  const { supportsHtml = true, richWriteFails = false, plainWriteResult } = options;
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
      return plainWriteResult;
    },
  };

  return { environment, richWrites, plainTexts };
}

describe("createSelectionClipboardContent", () => {
  it.each(["README.md", "main.py", "https://example.com", "www.example.com", "user@example.com"])(
    "keeps bare text unlinked in clipboard HTML: %s",
    (text) => {
      expect(createSelectionClipboardContent(text, text)).toEqual({
        plainText: text,
        html: `<meta charset="utf-8"><p>${text}</p>\n`,
      });
    },
  );

  it("writes the given plain flavor", () => {
    expect(createSelectionClipboardContent("a \\| b", "a | b")).toEqual({
      plainText: "a | b",
      html: '<meta charset="utf-8"><p>a | b</p>\n',
    });
  });
});

describe("createMarkdownClipboardContent", () => {
  it("links a bare URL in clipboard HTML", () => {
    expect(createMarkdownClipboardContent("https://example.com").html).toBe(
      '<meta charset="utf-8"><p><a href="https://example.com">https://example.com</a></p>\n',
    );
  });

  it("preserves explicit filename and web links in clipboard HTML", () => {
    const markdown = "[README.md](README.md) and [website](https://example.com)";

    expect(createMarkdownClipboardContent(markdown)).toEqual({
      plainText: markdown,
      html: '<meta charset="utf-8"><p><a href="README.md">README.md</a> and <a href="https://example.com">website</a></p>\n',
    });
  });

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

  it("preserves assistant file links without allowing unsafe link schemes", () => {
    const content = createMarkdownClipboardContent(
      [
        "[file](file:///tmp/paseo%20notes.md#L4)",
        '[javascript](javascript:alert("x"))',
        "[data](data:text/html,unsafe)",
        "[vbscript](vbscript:msgbox(1))",
      ].join("\n\n"),
    );

    expect(content.html).toContain('<a href="file:///tmp/paseo%20notes.md#L4">file</a>');
    expect(content.html).not.toMatch(/href="(?:javascript|data|vbscript):/);
  });
});

describe("createCodeClipboardContent", () => {
  it("keeps the code verbatim and escapes it for the html half", () => {
    const content = createCodeClipboardContent('if (a < b && c > "d") {', { block: false });

    expect(content.plainText).toBe('if (a < b && c > "d") {');
    expect(content.html).toContain("if (a &lt; b &amp;&amp; c &gt;");
  });

  it("leaves a single line undecorated but wraps multi-line code in pre", () => {
    expect(createCodeClipboardContent("one", { block: false }).html).not.toContain("<code>");
    expect(createCodeClipboardContent("one\ntwo", { block: true }).html).toContain(
      "<pre><code>one\ntwo</code></pre>",
    );
  });

  it("adds a language class only when the info string carries one", () => {
    expect(createCodeClipboardContent("x\ny", { block: true, language: "  " }).html).toContain(
      "<pre><code>",
    );
    expect(createCodeClipboardContent("x\ny", { block: true, language: "ts" }).html).toContain(
      '<pre><code class="language-ts">',
    );
  });

  it("escapes an info string that would break out of the class attribute", () => {
    const content = createCodeClipboardContent("x\ny", {
      block: true,
      language: 'ts" onload="alert(1)',
    });

    expect(content.html).toContain('class="language-ts&quot; onload=&quot;alert(1)"');
    expect(content.html).not.toContain('onload="alert(1)"');
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

describe("writeClipboardContent", () => {
  const content = { plainText: "_raw_ draft", html: "<p>\\_raw\\_ draft</p>" };

  it("writes both flavors and reports the write", async () => {
    const clipboard = createRecordingClipboard();

    await expect(writeClipboardContent(content, clipboard.environment)).resolves.toBe(true);

    const written = clipboard.richWrites[0];
    if (!written) {
      throw new Error("Expected rich clipboard data to be written");
    }
    await expect(written["text/plain"].text()).resolves.toBe(content.plainText);
    await expect(written["text/html"].text()).resolves.toBe(content.html);
  });

  it("falls back to the plain flavor when the rich write fails", async () => {
    const clipboard = createRecordingClipboard({ richWriteFails: true });

    await expect(writeClipboardContent(content, clipboard.environment)).resolves.toBe(true);

    expect(clipboard.plainTexts).toEqual([content.plainText]);
  });

  it("reports a plain write the host refused", async () => {
    const clipboard = createRecordingClipboard({ supportsHtml: false, plainWriteResult: false });

    await expect(writeClipboardContent(content, clipboard.environment)).resolves.toBe(false);
  });

  it("propagates a plain write that throws", async () => {
    const environment: MarkdownClipboardEnvironment = {
      writePlainText: async () => {
        throw new Error("clipboard denied");
      },
    };

    await expect(writeClipboardContent(content, environment)).rejects.toThrow("clipboard denied");
  });
});
