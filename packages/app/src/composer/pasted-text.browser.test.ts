import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownClipboardContent } from "@/utils/rich-clipboard";
import { pasteLinkedClipboardText } from "./pasted-text.web";

const inputs: HTMLTextAreaElement[] = [];
function editor(): HTMLTextAreaElement {
  const input = document.createElement("textarea");
  document.body.append(input);
  inputs.push(input);
  return input;
}
afterEach(() => {
  for (const input of inputs.splice(0)) input.remove();
});

function clipboard(html: string, text: string): DataTransfer {
  const data = new DataTransfer();
  data.setData("text/html", html);
  data.setData("text/plain", text);
  return data;
}

describe("pasted prompt links", () => {
  it.each([
    "https://example.com/1",
    "https://example.com/日本語",
    "<https://example.com/a b>",
    "https://例え.テスト/issue",
  ])("keeps complete Markdown from Copy with destination %s", (destination) => {
    const source = `| Resource | Status |\n| --- | --- |\n| [issue](${destination}) | ~~closed~~ |`;
    const content = createMarkdownClipboardContent(source);
    const input = editor();
    expect(pasteLinkedClipboardText(input, clipboard(content.html, content.plainText))).toBe(false);
    expect(input.value).toBe("");
  });
  it("converts external links when plain text names the resource but omits a destination", () => {
    const input = editor();
    expect(
      pasteLinkedClipboardText(
        input,
        clipboard(
          '<a href="https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E">日本語</a> and <a href="https://example.com/missing">another</a>',
          "[日本語](https://example.com/日本語) and another",
        ),
      ),
    ).toBe(true);
    expect(input.value).toBe(
      "[日本語](https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E) and [another](https://example.com/missing)",
    );
  });
  it("preserves a labeled resource URL as Markdown", () => {
    const data = clipboard(
      'Hey can you take a look at <a href="https://example.com/issues/39150">this FR</a> and...',
      "Hey can you take a look at this FR and...",
    );
    const input = editor();
    expect(pasteLinkedClipboardText(input, data)).toBe(true);
    expect(input.value).toBe(
      "Hey can you take a look at [this FR](https://example.com/issues/39150) and...",
    );
  });

  it("preserves external linked table rows and columns", () => {
    const input = editor();
    expect(
      pasteLinkedClipboardText(
        input,
        clipboard(
          '<table><thead><tr><th>Resource</th><th>Status</th></tr></thead><tbody><tr><td><a href="https://example.com/issue">Issue</a></td><td>closed</td></tr></tbody></table>',
          "Resource\tStatus\nIssue\tclosed",
        ),
      ),
    ).toBe(true);
    expect(input.value).toBe(
      "| Resource | Status |\n| --- | --- |\n| [Issue](https://example.com/issue) | closed |",
    );
  });

  it("keeps table cell separators and line breaks inside their cells", () => {
    const input = editor();
    expect(
      pasteLinkedClipboardText(
        input,
        clipboard(
          '<table><tr><th>Resource</th><th>Status</th></tr><tr><td><a href="https://example.com/issue">Issue | tracker</a></td><td>closed<br>today</td></tr></table>',
          "Resource\tStatus\nIssue | tracker\tclosed today",
        ),
      ),
    ).toBe(true);
    expect(input.value).toBe(
      "| Resource | Status |\n| --- | --- |\n| [Issue \\| tracker](https://example.com/issue) | closed<br>today |",
    );
  });

  it("retains headerless tables as HTML without inventing a heading", () => {
    const html =
      '<table><tbody><tr><td><a href="https://example.com/issue">Issue</a></td><td>closed</td></tr><tr><td>Other</td><td>open</td></tr></tbody></table>';
    const input = editor();
    expect(pasteLinkedClipboardText(input, clipboard(html, "Issue\tclosed\nOther\topen"))).toBe(
      true,
    );
    expect(input.value).toBe(html);
  });

  it.each([
    ["<table></table>", ""],
    ["<table><caption>Context</caption></table>", "\n\nContext"],
  ])("keeps surrounding links when a table has no rows: %s", (table, caption) => {
    const input = editor();
    expect(
      pasteLinkedClipboardText(
        input,
        clipboard(`<a href="https://example.com/">Issue</a>${table}`, "Issue"),
      ),
    ).toBe(true);
    expect(input.value).toBe(`[Issue](https://example.com/)${caption}`);
  });

  it("leaves plain text and rich text without links to native paste", () => {
    const input = editor();
    expect(pasteLinkedClipboardText(input, clipboard("", "[link](https://example.com)"))).toBe(
      false,
    );
    expect(pasteLinkedClipboardText(input, clipboard("<b>hello</b>", "hello"))).toBe(false);
    expect(pasteLinkedClipboardText(input, null)).toBe(false);
    expect(input.value).toBe("");
  });

  it("keeps paragraphs and multiple links", () => {
    const input = editor();
    expect(
      pasteLinkedClipboardText(
        input,
        clipboard(
          '<p>See <a href="https://example.com/a">one</a></p><p>and <a href="https://example.com/b">two</a></p>',
          "See one\n\nand two",
        ),
      ),
    ).toBe(true);
    expect(input.value).toBe(
      "See [one](https://example.com/a)\n\nand [two](https://example.com/b)",
    );
  });
});
