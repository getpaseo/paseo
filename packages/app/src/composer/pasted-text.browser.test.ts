import { describe, expect, it } from "vitest";
import { readLinkedClipboardText } from "./pasted-text.web";

function clipboard(html: string, text: string): DataTransfer {
  const data = new DataTransfer();
  data.setData("text/html", html);
  data.setData("text/plain", text);
  return data;
}

describe("pasted prompt links", () => {
  it("preserves a labeled resource URL as Markdown", () => {
    const data = clipboard(
      'Hey can you take a look at <a href="https://example.com/issues/39150">this FR</a> and...',
      "Hey can you take a look at this FR and...",
    );
    expect(readLinkedClipboardText(data)).toBe(
      "Hey can you take a look at [this FR](https://example.com/issues/39150) and...",
    );
  });

  it("leaves plain text and rich text without links to native paste", () => {
    expect(readLinkedClipboardText(clipboard("", "[link](https://example.com)"))).toBeNull();
    expect(readLinkedClipboardText(clipboard("<b>hello</b>", "hello"))).toBeNull();
    expect(readLinkedClipboardText(null)).toBeNull();
  });

  it("keeps paragraphs and multiple links", () => {
    expect(
      readLinkedClipboardText(
        clipboard(
          '<p>See <a href="https://example.com/a">one</a></p><p>and <a href="https://example.com/b">two</a></p>',
          "See one\n\nand two",
        ),
      ),
    ).toBe("See [one](https://example.com/a)\n\nand [two](https://example.com/b)");
  });
});
