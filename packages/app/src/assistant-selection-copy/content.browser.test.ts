import { afterEach, describe, expect, it } from "vitest";
import { createAssistantSelectionClipboardContent } from "./content.web";

const fixture = `
  <div data-testid="assistant-message">
    <div data-paseo-markdown-tag="p">Prefix <span data-paseo-markdown-tag="strong">bold text</span> and <span data-paseo-markdown-tag="code">inline code</span> suffix.</div>
    <div data-paseo-markdown-tag="ul">
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span><div><span>First bullet text</span></div></div>
      <div data-paseo-markdown-tag="li"><span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span><div><span>Second bullet text</span></div></div>
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

  it.each(["strong", "em", "s", "h2", "blockquote"])(
    "copies all content selected from inside a %s element without its syntax",
    (tag) => {
      const message = mountFixture();
      const element = fixtureElement(message, '[data-paseo-markdown-tag="strong"]');
      element.setAttribute("data-paseo-markdown-tag", tag);
      const content = createAssistantSelectionClipboardContent(
        selectText(element, 0, textNode(element).length),
      );
      expect(content?.plainText).toBe("bold text");
      expect(content?.html).not.toContain(`<${tag}>`);
    },
  );

  it("copies complete inline code without delimiters when the selection stays inside", () => {
    const message = mountFixture();
    const element = fixtureElement(message, '[data-paseo-markdown-tag="code"]');
    const content = createAssistantSelectionClipboardContent(
      selectText(element, 0, textNode(element).length),
    );
    expect(content?.plainText).toBe("inline code");
    expect(content?.html).not.toContain("<code>");
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

  it("retains a bullet when a drag selects from the rendered marker through the item text", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    const content = createAssistantSelectionClipboardContent(
      selectRange(marker, 0, itemText, textNode(itemText).length),
    );
    expect(content?.plainText).toBe("- First bullet text");
    expect(content?.html).toContain("<div>- First bullet text</div>");
    expect(content?.html).not.toContain("<ul>");
    expect(content?.html).not.toContain("<li>");
  });

  it("retains a bullet when a drag includes the marker and part of the item text", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    expect(copiedMarkdown(selectRange(marker, 0, itemText, 5))).toBe("- First");
  });

  it("does not invent a bullet when a drag starts after the rendered marker", () => {
    const message = mountFixture();
    const marker = fixtureElement(message, '[data-paseo-markdown-list-marker="true"]');
    const itemText = fixtureElement(message, '[data-paseo-markdown-tag="li"] div span');

    expect(
      copiedMarkdown(
        selectRange(marker, textNode(marker).length, itemText, textNode(itemText).length),
      ),
    ).toBe("First bullet text");
  });

  it("retains every selected marker across a partial multi-item drag", () => {
    const message = mountFixture();
    const markerSelector = '[data-paseo-markdown-list-marker="true"]';
    const textSelector = '[data-paseo-markdown-tag="li"] div span';
    const firstMarker = fixtureElement(message, markerSelector);
    const secondText = fixtureElement(message, textSelector, 1);

    expect(copiedMarkdown(selectRange(firstMarker, 0, secondText, 6))).toBe(
      "- First bullet text\n- Second",
    );
  });

  it("retains the original number when a marker drag starts mid-list", () => {
    const message = mountFixture();
    const list = fixtureElement(message, '[data-paseo-markdown-tag="ul"]');
    list.setAttribute("data-paseo-markdown-tag", "ol");
    list.setAttribute("data-paseo-markdown-list-start", "5");
    const markers = list.querySelectorAll<HTMLElement>('[data-paseo-markdown-list-marker="true"]');
    markers.item(0).textContent = "5.";
    markers.item(1).textContent = "6.";
    const secondMarker = fixtureElement(list, '[data-paseo-markdown-list-marker="true"]', 1);
    const secondText = fixtureElement(list, '[data-paseo-markdown-tag="li"] div span', 1);

    expect(
      copiedMarkdown(selectRange(secondMarker, 0, secondText, textNode(secondText).length)),
    ).toBe("6. Second bullet text");
  });

  it("retains nested markers when a drag includes the complete outer item", () => {
    const message = mountFixture();
    const firstItem = fixtureElement(message, '[data-paseo-markdown-tag="li"]');
    firstItem.innerHTML = [
      '<span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span>',
      "<div>",
      "<span>Outer text</span>",
      '<div data-paseo-markdown-tag="ul">',
      '<div data-paseo-markdown-tag="li">',
      '<span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">•</span>',
      "<div><span>Inner text</span></div>",
      "</div>",
      "</div>",
      "</div>",
    ].join("");
    const outerMarker = fixtureElement(
      firstItem,
      ':scope > [data-paseo-markdown-list-marker="true"]',
    );
    const innerText = fixtureElement(
      firstItem,
      ':scope [data-paseo-markdown-tag="ul"] > [data-paseo-markdown-tag="li"] > div > span',
    );

    expect(copiedMarkdown(selectRange(outerMarker, 0, innerText, textNode(innerText).length))).toBe(
      "- Outer text\n    - Inner text",
    );
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

  it("copies code without a fence when every character is selected inside the block", () => {
    const message = mountFixture();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );
    expect(copiedMarkdown(selectText(blockCode, 0, textNode(blockCode).length))).toBe(
      "const answer = true;",
    );
  });
});

/**
 * The fixture above holds a code block in one text node. The real renderer splits a
 * highlighted line across one text node per syntax token and emits each newline as a
 * node of its own (`highlighted-code-block.tsx`), and it puts the hover Copy button
 * inside the `pre`. Line breaks and indentation only survive if the code skips
 * Turndown, so those cases need a fixture shaped like the real thing.
 */
function highlightedFixture(language: string | null): string {
  const languageAttribute =
    language === null ? "" : ` data-paseo-markdown-language="${escapeAttribute(language)}"`;
  return [
    '<div data-testid="assistant-message">',
    `<div data-paseo-markdown-tag="pre"${languageAttribute}>`,
    '<span data-paseo-markdown-tag="code">',
    "<span>const</span><span> answer</span><span> = 1;</span>",
    "<span>\n</span>",
    "<span>  if</span><span> (answer)</span><span> {</span>",
    "<span>\n</span>",
    "<span>    doThing();</span>",
    "</span>",
    '<div data-paseo-markdown-ignore="true"><span>Copy</span></div>',
    "</div>",
    '<div data-paseo-markdown-tag="p"><span>After the block.</span></div>',
    "</div>",
  ].join("");
}

function escapeAttribute(value: string): string {
  const holder = document.createElement("div");
  holder.setAttribute("data-value", value);
  return holder.outerHTML.slice('<div data-value="'.length, -"></div>".length);
}

function mountHighlighted(language: string | null = "typescript"): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = highlightedFixture(language);
  document.body.append(host);
  const message = host.querySelector<HTMLElement>('[data-testid="assistant-message"]');
  if (!message) {
    throw new Error("Expected assistant message fixture");
  }
  return message;
}

/** The single text node whose content is exactly `text`. */
function tokenText(root: Node, text: string): Text {
  const matches = allTextNodes(root, text);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one text node "${text}", found ${matches.length}`);
  }
  return matches[0];
}

function allTextNodes(root: Node, text: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode.textContent === text) {
      matches.push(walker.currentNode as Text);
    }
  }
  return matches;
}

/** The standalone `\n` node that ends rendered code line `index`. */
function lineBreak(root: Node, index: number): Text {
  const breaks = allTextNodes(root, "\n");
  const node = breaks[index];
  if (!node) {
    throw new Error(`Expected a line break at index ${index}, found ${breaks.length}`);
  }
  return node;
}

function copyBetween(start: [Text, number], end: [Text, number]) {
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return createAssistantSelectionClipboardContent(selection);
}

/** Select from the start of one text node to the end of another. */
function copyAcross(root: Node, startText: string, endText: string) {
  return copyBetween([tokenText(root, startText), 0], [tokenText(root, endText), endText.length]);
}

describe("assistant selection copy inside highlighted code", () => {
  it("keeps the line break and the indentation of a partial multi-line selection", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", " {");

    expect(content?.plainText).toBe("const answer = 1;\n  if (answer) {");
  });

  it("keeps multi-line code as a block in the html half so the lines survive", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toBe(
      '<meta charset="utf-8"><pre><code class="language-typescript">const answer = 1;\n  if (answer) {</code></pre>',
    );
  });

  it("does not escape Markdown characters inside copied code", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, " = 1;"), 1], [tokenText(message, " = 1;"), 5]);

    expect(content?.plainText).toBe("= 1;");
  });

  it("handles a common ancestor that is an element rather than a text node", () => {
    const message = mountHighlighted();

    // Spanning two token spans makes `commonAncestorContainer` the `code` element.
    const content = copyBetween(
      [tokenText(message, "const"), 1],
      [tokenText(message, " answer"), 4],
    );

    expect(content?.plainText).toBe("onst ans");
  });

  it("drops a trailing line break swept in from the end of a line", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, " = 1;"), 1], [lineBreak(message, 0), 1]);

    expect(content?.plainText).toBe("= 1;");
  });

  it("drops a trailing line break together with the indentation after it", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, "const"), 0], [tokenText(message, "  if"), 2]);

    expect(content?.plainText).toBe("const answer = 1;");
  });

  it("keeps line breaks that are not at the end of the selection", () => {
    const message = mountHighlighted();

    const content = copyBetween([tokenText(message, "const"), 0], [tokenText(message, "  if"), 4]);

    expect(content?.plainText).toBe("const answer = 1;\n  if");
  });

  it("leaves the hover copy button out of the copied code", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, " answer", "Copy");

    expect(content?.plainText).toBe(" answer = 1;\n  if (answer) {\n    doThing();");
    expect(content?.plainText).not.toContain("Copy");
  });

  it("does not treat a selection inside the copy button as code", () => {
    const message = mountHighlighted();

    expect(copyAcross(message, "Copy", "Copy")).toBeNull();
  });

  it("omits the language class when the fence carries no info string", () => {
    const message = mountHighlighted(null);

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toBe(
      '<meta charset="utf-8"><pre><code>const answer = 1;\n  if (answer) {</code></pre>',
    );
  });

  it("escapes a fence info string that would break out of the class attribute", () => {
    const message = mountHighlighted('ts" onload="x');

    const content = copyAcross(message, "const", " {");

    expect(content?.html).toContain('class="language-ts&quot; onload=&quot;x"');
    expect(content?.html).not.toContain('onload="x"');
  });

  it("copies a fully selected multi-line region as code when the selection stays inside", () => {
    const message = mountHighlighted();
    const blockCode = fixtureElement(
      message,
      '[data-paseo-markdown-tag="pre"] [data-paseo-markdown-tag="code"]',
    );

    expect(copiedMarkdown(selectNodeContents(blockCode))).toBe(
      "const answer = 1;\n  if (answer) {\n    doThing();",
    );
  });

  it("retains the fence when a complete code block is selected across its boundary", () => {
    const message = mountHighlighted();

    const content = copyAcross(message, "const", "After the block.");

    expect(content?.plainText).toBe(
      "```typescript\nconst answer = 1;\n  if (answer) {\n    doThing();\n```\n\nAfter the block.",
    );
  });
});
