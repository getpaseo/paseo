import { afterEach, describe, expect, it } from "vitest";
import { createAssistantSelectionClipboardContent } from "./content.web";

const fixture = `
  <div data-testid="assistant-message">
    <div data-paseo-markdown-tag="p">Prefix <span data-paseo-markdown-tag="strong">bold text</span> and <span data-paseo-markdown-tag="code">inline code</span> suffix.</div>
    <div data-paseo-markdown-tag="ul">
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true">•</span><div><span>First bullet text</span></div></div>
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true">•</span><div><span>Second bullet text</span></div></div>
    </div>
    <div data-paseo-markdown-tag="pre" data-paseo-markdown-language="ts"><span data-paseo-markdown-tag="code">const answer = true;</span></div>
  </div>
`;

function mountFixture(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = fixture;
  document.body.append(host);
  const message = host.querySelector<HTMLElement>('[data-testid="assistant-message"]');
  if (!message) {
    throw new Error("Expected assistant message fixture");
  }
  return message;
}

function textNode(element: Element): Text {
  const node = element.firstChild;
  if (!(node instanceof Text)) {
    throw new Error("Expected text node");
  }
  return node;
}

function selectText(element: Element, start: number, end: number): Selection {
  const node = textNode(element);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function selectRange(
  startElement: Element,
  startOffset: number,
  endElement: Element,
  endOffset: number,
): Selection {
  const range = document.createRange();
  range.setStart(textNode(startElement), startOffset);
  range.setEnd(textNode(endElement), endOffset);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function selectNodeContents(element: Element): Selection {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function copiedMarkdown(selection: Selection): string | null {
  return createAssistantSelectionClipboardContent(selection)?.plainText ?? null;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("assistant selection copy ranges", () => {
  it("does not handle absent, collapsed, or non-assistant selections", () => {
    expect(createAssistantSelectionClipboardContent(null)).toBeNull();

    const message = mountFixture();
    const strong = message.querySelector('[data-paseo-markdown-tag="strong"]');
    if (!strong) {
      throw new Error("Expected strong text");
    }
    expect(copiedMarkdown(selectText(strong, 2, 2))).toBeNull();

    const outside = document.createElement("span");
    outside.textContent = "outside";
    document.body.append(outside);
    expect(copiedMarkdown(selectText(outside, 0, 7))).toBeNull();
  });

  it("does not replace the browser clipboard for a range spanning assistant messages", () => {
    const firstMessage = mountFixture();
    const secondMessage = mountFixture();
    const firstText = firstMessage.querySelector('[data-paseo-markdown-tag="strong"]');
    const secondText = secondMessage.querySelector('[data-paseo-markdown-tag="strong"]');
    if (!firstText || !secondText) {
      throw new Error("Expected text in both assistant messages");
    }
    expect(copiedMarkdown(selectRange(firstText, 0, secondText, 4))).toBeNull();
  });

  it("preserves all structure when the complete assistant message is selected", () => {
    const message = mountFixture();
    const content = createAssistantSelectionClipboardContent(selectNodeContents(message));
    expect(content?.plainText).toBe(
      [
        "Prefix **bold text** and `inline code` suffix.",
        "",
        "- First bullet text",
        "- Second bullet text",
        "",
        "```ts",
        "const answer = true;",
        "```",
      ].join("\n"),
    );
    expect(content?.html).not.toContain("<ul>");
    expect(content?.html).not.toContain("<li>");
    expect(content?.html).toContain("<div>- First bullet text</div>");
    expect(content?.html).toContain("<div>- Second bullet text</div>");
  });

  it.each([
    { tag: "strong", range: [1, 5], expected: "old", forbiddenHtml: "<strong>" },
    { tag: "code", range: [2, 8], expected: "line c", forbiddenHtml: "<code>" },
  ])(
    "copies a partial $tag range without expanding to its delimiters",
    ({ tag, range, expected, forbiddenHtml }) => {
      const message = mountFixture();
      const element = message.querySelector(`[data-paseo-markdown-tag="${tag}"]`);
      if (!element) {
        throw new Error(`Expected ${tag} text`);
      }
      const content = createAssistantSelectionClipboardContent(
        selectText(element, range[0], range[1]),
      );
      expect(content?.plainText).toBe(expected);
      expect(content?.html).not.toContain(forbiddenHtml);
    },
  );

  it.each([
    { tag: "strong", expected: "**bold text**" },
    { tag: "code", expected: "`inline code`" },
  ])("retains $tag delimiters when its complete contents are selected", ({ tag, expected }) => {
    const message = mountFixture();
    const elements = message.querySelectorAll(`[data-paseo-markdown-tag="${tag}"]`);
    const element = tag === "code" ? elements[0] : elements.item(0);
    if (!element?.textContent) {
      throw new Error(`Expected ${tag} text`);
    }
    const content = createAssistantSelectionClipboardContent(
      selectText(element, 0, element.textContent.length),
    );
    expect(content?.plainText).toBe(expected);
    expect(content?.html).toContain(`<${tag}>`);
  });

  it("keeps a complete inline node but drops formatting from a partial node at the other edge", () => {
    const message = mountFixture();
    const strong = message.querySelector('[data-paseo-markdown-tag="strong"]');
    const code = message.querySelector('[data-paseo-markdown-tag="code"]');
    if (!strong?.textContent || !code) {
      throw new Error("Expected formatted inline text");
    }
    expect(copiedMarkdown(selectRange(strong, 0, code, 6))).toBe("**bold text** and inline");
  });

  it("copies list-item text without inventing a bullet", () => {
    const message = mountFixture();
    const itemText = message.querySelector('[data-paseo-markdown-tag="li"] div span');
    if (!itemText?.textContent) {
      throw new Error("Expected list item text");
    }
    const content = createAssistantSelectionClipboardContent(
      selectText(itemText, 0, itemText.textContent.length),
    );
    expect(content?.plainText).toBe("First bullet text");
    expect(content?.html).toContain("<p>First bullet text</p>");
    expect(content?.html).not.toContain("<li>");
  });

  it("retains a bullet when the range includes the marker and the complete item", () => {
    const message = mountFixture();
    const item = message.querySelector('[data-paseo-markdown-tag="li"]');
    if (!item) {
      throw new Error("Expected list item");
    }
    expect(copiedMarkdown(selectNodeContents(item))).toBe("- First bullet text");
  });

  it("omits a partial leading bullet and retains the marker crossed before the trailing item", () => {
    const message = mountFixture();
    const itemTexts = message.querySelectorAll('[data-paseo-markdown-tag="li"] div span');
    const first = itemTexts[0];
    const second = itemTexts[1];
    if (!first || !second?.textContent) {
      throw new Error("Expected two list items");
    }
    expect(copiedMarkdown(selectRange(first, 6, second, second.textContent.length))).toBe(
      "bullet text\n\n- Second bullet text",
    );
  });

  it("copies part of a fenced code block without adding an inline or fenced delimiter", () => {
    const message = mountFixture();
    const blockCode = message.querySelector(
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    if (!blockCode) {
      throw new Error("Expected fenced code text");
    }
    const content = createAssistantSelectionClipboardContent(selectText(blockCode, 6, 12));
    expect(content?.plainText).toBe("answer");
    expect(content?.html).not.toContain("<code>");
    expect(content?.html).not.toContain("<pre>");
  });

  it("retains the fence and language when the complete code block is selected", () => {
    const message = mountFixture();
    const blockCode = message.querySelector(
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    if (!blockCode?.textContent) {
      throw new Error("Expected fenced code text");
    }
    expect(copiedMarkdown(selectText(blockCode, 0, blockCode.textContent.length))).toBe(
      "```ts\nconst answer = true;\n```",
    );
  });
});
