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
  it("keeps complete Markdown from Copy without reconverting its linked table or strikethrough", () => {
    const source =
      "| Resource | Status |\n| --- | --- |\n| [issue](https://example.com/1) | ~~closed~~ |";
    const content = createMarkdownClipboardContent(source);
    const input = editor();
    expect(pasteLinkedClipboardText(input, clipboard(content.html, content.plainText))).toBe(false);
    expect(input.value).toBe("");
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
