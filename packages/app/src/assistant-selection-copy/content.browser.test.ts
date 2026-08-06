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

function fixtureElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
  index = 0,
): T {
  const element = root.querySelectorAll<T>(selector).item(index);
  if (!element) {
    throw new Error(`Expected fixture element ${selector} at index ${index}`);
  }
  return element;
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
    const strong = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
    expect(copiedMarkdown(selectText(strong, 2, 2))).toBeNull();

    const outside = document.createElement("span");
    outside.textContent = "outside";
    document.body.append(outside);
    expect(copiedMarkdown(selectText(outside, 0, 7))).toBeNull();
  });

  it("does not replace the browser clipboard for a range spanning assistant messages", () => {
    const firstMessage = mountFixture();
    const secondMessage = mountFixture();
    const firstText = fixtureElement(firstMessage, '[data-paseo-markdown-tag="strong"]');
    const secondText = fixtureElement(secondMessage, '[data-paseo-markdown-tag="strong"]');
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
      const element = fixtureElement(message, `[data-paseo-markdown-tag="${tag}"]`);
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
    const element = fixtureElement(message, `[data-paseo-markdown-tag="${tag}"]`);
    const content = createAssistantSelectionClipboardContent(
      selectText(element, 0, textNode(element).length),
    );
    expect(content?.plainText).toBe(expected);
    expect(content?.html).toContain(`<${tag}>`);
  });

  it("keeps a complete inline node but drops formatting from a partial node at the other edge", () => {
    const message = mountFixture();
    const strong = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
    const code = fixtureElement(message, '[data-paseo-markdown-tag="code"]');
    expect(copiedMarkdown(selectRange(strong, 0, code, 6))).toBe("**bold text** and inline");
  });

  it("copies list-item text without inventing a bullet", () => {
    const message = mountFixture();
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');
    const content = createAssistantSelectionClipboardContent(
      selectText(itemText, 0, textNode(itemText).length),
    );
    expect(content?.plainText).toBe("First bullet text");
    expect(content?.html).toContain("<p>First bullet text</p>");
    expect(content?.html).not.toContain("<li>");
  });

  it("retains a bullet when the range includes the marker and the complete item", () => {
    const message = mountFixture();
    const item = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    expect(copiedMarkdown(selectNodeContents(item))).toBe("- First bullet text");
  });

  it("preserves paragraph breaks when rich HTML flattens a loose list item", () => {
    const message = mountFixture();
    const item = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    item.replaceChildren();
    item.insertAdjacentHTML(
      "beforeend",
      '<div data-paseo-markdown-tag="p">First paragraph</div><div data-paseo-markdown-tag="p">Second paragraph</div>',
    );

    const content = createAssistantSelectionClipboardContent(selectNodeContents(item));
    expect(content?.plainText).toBe("- First paragraph\n\n    Second paragraph");
    expect(content?.html).toMatch(/<div>-\s*First paragraph\s*<br><br>Second paragraph\s*<\/div>/);
  });

  it("omits a partial leading bullet and retains the marker crossed before the trailing item", () => {
    const message = mountFixture();
    const selector = '[data-paseo-markdown-tag="li"] div span';
    const first = fixtureElement(message, selector);
    const second = fixtureElement(message, selector, 1);
    expect(copiedMarkdown(selectRange(first, 6, second, textNode(second).length))).toBe(
      "bullet text\n\n- Second bullet text",
    );
  });

  it("copies part of a fenced code block without adding an inline or fenced delimiter", () => {
    const message = mountFixture();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    const content = createAssistantSelectionClipboardContent(selectText(blockCode, 6, 12));
    expect(content?.plainText).toBe("answer");
    expect(content?.html).not.toContain("<code>");
    expect(content?.html).not.toContain("<pre>");
  });

  it("retains the fence and language when the complete code block is selected", () => {
    const message = mountFixture();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    expect(copiedMarkdown(selectText(blockCode, 0, textNode(blockCode).length))).toBe(
      "```ts\nconst answer = true;\n```",
    );
  });
});
