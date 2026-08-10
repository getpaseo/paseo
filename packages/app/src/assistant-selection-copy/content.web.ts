import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  createCodeClipboardContent,
  createMarkdownClipboardContent,
  type MarkdownClipboardContent,
} from "@/utils/rich-clipboard";
import {
  MARKDOWN_COPY_ALIGN_ATTRIBUTE,
  MARKDOWN_COPY_IGNORE_ATTRIBUTE,
  MARKDOWN_COPY_LANGUAGE_ATTRIBUTE,
  MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE,
  MARKDOWN_COPY_LIST_START_ATTRIBUTE,
  MARKDOWN_COPY_TAG_ATTRIBUTE,
  MARKDOWN_COPY_UNWRAP_ATTRIBUTE,
  TRAILING_CODE_LINE_BREAKS,
} from "./markup";

const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';
const CODE_BLOCK_SELECTOR = `[${MARKDOWN_COPY_TAG_ATTRIBUTE}="pre"]`;
const CODE_REGION_SELECTOR = `${CODE_BLOCK_SELECTOR}, [${MARKDOWN_COPY_TAG_ATTRIBUTE}="code"]`;

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
});
turndown.use(gfm);
turndown.addRule("escapedGfmTableCell", {
  filter: ["th", "td"],
  replacement: (content, node) => {
    const index = node.parentNode ? Array.from(node.parentNode.childNodes).indexOf(node) : 0;
    const prefix = index === 0 ? "| " : " ";
    return `${prefix}${content.replace(/\|/g, "\\|")} |`;
  },
});
turndown.addRule("gfmStrikethrough", {
  filter: ["del", "s"],
  replacement: (content) => `~~${content}~~`,
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const item = content
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .replace(/\n(?=\S)/g, "\n    ");
    const parent = node.parentElement;
    if (parent?.nodeName !== "OL") {
      return `${options.bulletListMarker} ${item}\n`;
    }
    const start = Number(parent.getAttribute("start") ?? 1);
    const index = Array.from(parent.children).indexOf(node);
    return `${start + index}. ${item}\n`;
  },
});

export function createAssistantSelectionClipboardContent(
  selection: Selection | null,
): MarkdownClipboardContent | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const startMessage = closestAssistantMessage(range.startContainer);
  const endMessage = closestAssistantMessage(range.endContainer);
  if (!startMessage || startMessage !== endMessage) {
    return null;
  }

  const partialCode = createPartialCodeContent(range, startMessage);
  if (partialCode) {
    return partialCode;
  }

  const container = document.createElement("div");
  const selected = cloneMarkdownSelection(range, startMessage);
  container.append(selected);
  restoreMarkdownElements(container);

  const markdown = turndown.turndown(container.innerHTML).trim();
  if (!markdown) {
    return null;
  }
  const content = createMarkdownClipboardContent(markdown);
  return { ...content, html: flattenClipboardListMarkup(content.html) };
}

/**
 * Partly-selected code copies as the code itself, never through Turndown.
 *
 * `removeUnselectedSemantics` strips the `pre`/`code` tags from a partial selection,
 * which is right for the Markdown syntax but leaves the code being serialized as
 * prose: Turndown collapses the indentation and the line breaks, and escapes
 * Markdown-significant characters inside it. Two selected lines arrive as one.
 *
 * A selection contained inside code always copies as code, even when it contains every
 * character. A selection that crosses the code boundary stays on the Markdown path so
 * a complete block retains its fence.
 */
function createPartialCodeContent(range: Range, message: Element): MarkdownClipboardContent | null {
  const region = closestCodeRegion(range.commonAncestorContainer, message);
  if (!region) {
    return null;
  }

  const code = selectedCodeText(range);
  if (!code) {
    return null;
  }

  // `closest` stops at the inner `code` span, but the fence language lives on the
  // outer `pre` wrapper.
  const fence = region.closest(CODE_BLOCK_SELECTOR);

  // Only multi-line code earns markup in the html half, and only because HTML would
  // otherwise collapse the newlines. A single line stays undecorated, like every
  // other partial selection.
  const block = Boolean(fence) && code.includes("\n");
  return createCodeClipboardContent(code, {
    language: fence?.getAttribute(MARKDOWN_COPY_LANGUAGE_ATTRIBUTE),
    block,
  });
}

function closestCodeRegion(node: Node, message: Element): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  const region = element?.closest(CODE_REGION_SELECTOR) ?? null;
  if (!region || !message.contains(region)) {
    return null;
  }
  // A selection sitting entirely inside the block's own hover Copy button is not
  // code. `cloneContents` of a single text node drops the ignore marker with the
  // element that carried it, so this has to be asked of the live DOM.
  return element?.closest(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`) ? null : region;
}

function selectedCodeText(range: Range): string {
  const fragment = range.cloneContents();
  // The hover Copy button lives inside the `pre`, so a selection that reaches the
  // end of the block sweeps it up too.
  for (const ignored of fragment.querySelectorAll(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`)) {
    ignored.remove();
  }
  // Deliberately untrimmed — leading indentation is part of the code. Trailing line
  // breaks are the exception: newlines are their own text nodes between rendered
  // lines, so a selection that overshoots the end of a line sweeps one in.
  return (fragment.textContent ?? "").replace(TRAILING_CODE_LINE_BREAKS, "");
}

function flattenClipboardListMarkup(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;

  const lists = Array.from(container.querySelectorAll("ul, ol")).toReversed();
  for (const list of lists) {
    const replacement = document.createDocumentFragment();
    const items = Array.from(list.children).filter((child) => child.tagName === "LI");
    const start = list.tagName === "OL" ? Number(list.getAttribute("start") ?? 1) : null;

    items.forEach((item, index) => {
      const line = document.createElement("div");
      line.append(start === null ? "- " : `${start + index}. `);
      const nestedLines: HTMLDivElement[] = [];
      let hasParagraph = false;
      for (const child of Array.from(item.childNodes)) {
        if (child instanceof HTMLDivElement) {
          nestedLines.push(child);
        } else if (child instanceof HTMLParagraphElement) {
          if (hasParagraph) {
            line.append(document.createElement("br"), document.createElement("br"));
          }
          line.append(...child.childNodes);
          hasParagraph = true;
        } else {
          line.append(child);
        }
      }
      replacement.append(line, ...nestedLines);
    });
    list.replaceWith(replacement);
  }

  return container.innerHTML;
}

function cloneMarkdownSelection(range: Range, message: Element): Node {
  const clonedMessage = message.cloneNode(true) as Element;
  const clonedRange = cloneRangeInto(range, message, clonedMessage);
  removeUnselectedSemantics(range, message, clonedMessage);

  let selected: Node = clonedRange.cloneContents();
  let ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  while (ancestor && ancestor !== message) {
    if (shouldPreserveSemanticElement(range, ancestor)) {
      const wrapper = ancestor.cloneNode(false) as Element;
      normalizeOrderedListStart(wrapper, ancestor, range);
      wrapper.append(selected);
      selected = wrapper;
    }
    ancestor = ancestor.parentElement;
  }

  return selected;
}

function cloneRangeInto(range: Range, source: Element, clone: Element): Range {
  const clonedRange = document.createRange();
  clonedRange.setStart(
    nodeAtPath(clone, nodePath(source, range.startContainer)),
    range.startOffset,
  );
  clonedRange.setEnd(nodeAtPath(clone, nodePath(source, range.endContainer)), range.endOffset);
  return clonedRange;
}

function nodePath(root: Node, node: Node): number[] {
  const path: number[] = [];
  let current = node;
  while (current !== root) {
    const parent = current.parentNode;
    if (!parent) {
      throw new Error("Selection boundary is outside its assistant message");
    }
    path.unshift(Array.from(parent.childNodes).findIndex((child) => child === current));
    current = parent;
  }
  return path;
}

function nodeAtPath(root: Node, path: number[]): Node {
  let current = root;
  for (const index of path) {
    const child = current.childNodes[index];
    if (!child) {
      throw new Error("Cloned assistant message does not match the selection source");
    }
    current = child;
  }
  return current;
}

function removeUnselectedSemantics(range: Range, source: Element, clone: Element): void {
  const selector = `[${MARKDOWN_COPY_TAG_ATTRIBUTE}], a`;
  const originals = Array.from(source.querySelectorAll(selector));
  const copies = Array.from(clone.querySelectorAll(selector));

  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!copy || shouldPreserveSemanticElement(range, original)) {
      if (copy) {
        normalizeOrderedListStart(copy, original, range);
      }
      return;
    }
    const tag = original.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE);
    if (tag && isBlockBoundary(tag)) {
      copy.setAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE, "p");
      return;
    }
    copy.removeAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE);
    if (copy.tagName === "A") {
      copy.setAttribute(MARKDOWN_COPY_UNWRAP_ATTRIBUTE, "true");
    }
  });
}

function shouldPreserveSemanticElement(range: Range, element: Element): boolean {
  if (!range.intersectsNode(element)) {
    return false;
  }
  const tag = element.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE);
  if (tag === "p" || isTableStructure(tag)) {
    return true;
  }
  const isSelectableSemantic = tag !== null && tag !== "li" && tag !== "ol" && tag !== "ul";
  if (
    (isSelectableSemantic || element.tagName === "A") &&
    selectionStaysInsideElement(range, element)
  ) {
    return false;
  }
  if (tag === "ol" || tag === "ul") {
    const selectedItems = selectedListItems(element, range);
    return selectedItems.some(
      (item) => hasSelectedListMarker(range, item) || hasSelectedAllContents(range, item, true),
    );
  }
  if (tag === "li" && hasSelectedListMarker(range, element)) {
    return true;
  }
  return hasSelectedAllContents(range, element, tag === "li");
}

function selectionStaysInsideElement(range: Range, element: Element): boolean {
  return (
    range.startContainer !== element &&
    range.endContainer !== element &&
    element.contains(range.startContainer) &&
    element.contains(range.endContainer)
  );
}

function selectedListItems(list: Element, range: Range): Element[] {
  return Array.from(list.children).filter(
    (child) =>
      child.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE) === "li" &&
      (child.contains(range.startContainer) ||
        child.contains(range.endContainer) ||
        hasSelectedAllContents(range, child, true)),
  );
}

function hasSelectedListMarker(range: Range, item: Element): boolean {
  const marker = item.querySelector(`:scope > [${MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE}]`);
  if (!marker) {
    return false;
  }

  const markerContents = document.createRange();
  markerContents.selectNodeContents(marker);
  const selectionEndsBeforeMarker =
    range.compareBoundaryPoints(Range.END_TO_START, markerContents) >= 0;
  const selectionStartsAfterMarker =
    range.compareBoundaryPoints(Range.START_TO_END, markerContents) <= 0;
  if (selectionEndsBeforeMarker || selectionStartsAfterMarker) {
    return false;
  }

  if (range.compareBoundaryPoints(Range.START_TO_START, markerContents) > 0) {
    markerContents.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, markerContents) < 0) {
    markerContents.setEnd(range.endContainer, range.endOffset);
  }
  return hasMarkdownContent(markerContents.cloneContents(), true);
}

function normalizeOrderedListStart(copy: Element, original: Element, range: Range): void {
  if (original.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE) !== "ol") {
    return;
  }
  const firstSelectedItem = selectedListItems(original, range)[0];
  if (!firstSelectedItem) {
    return;
  }
  const items = Array.from(original.children).filter(
    (child) => child.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE) === "li",
  );
  const omittedItems = items.indexOf(firstSelectedItem);
  const originalStart = Number(original.getAttribute(MARKDOWN_COPY_LIST_START_ATTRIBUTE) ?? 1);
  copy.setAttribute(MARKDOWN_COPY_LIST_START_ATTRIBUTE, String(originalStart + omittedItems));
}

function hasSelectedAllContents(range: Range, element: Element, includeIgnored = false): boolean {
  const contents = document.createRange();
  contents.selectNodeContents(element);

  if (range.compareBoundaryPoints(Range.START_TO_START, contents) > 0) {
    const before = contents.cloneRange();
    before.setEnd(range.startContainer, range.startOffset);
    if (hasMarkdownContent(before.cloneContents(), includeIgnored)) {
      return false;
    }
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, contents) < 0) {
    const after = contents.cloneRange();
    after.setStart(range.endContainer, range.endOffset);
    if (hasMarkdownContent(after.cloneContents(), includeIgnored)) {
      return false;
    }
  }
  return true;
}

function hasMarkdownContent(fragment: DocumentFragment, includeIgnored: boolean): boolean {
  if (!includeIgnored) {
    for (const ignored of fragment.querySelectorAll(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`)) {
      ignored.remove();
    }
  }
  if (fragment.textContent) {
    return true;
  }
  const visibleVoidSelector = ["br", "hr"]
    .map((tag) => `[${MARKDOWN_COPY_TAG_ATTRIBUTE}="${tag}"]`)
    .join(",");
  return Boolean(fragment.querySelector(visibleVoidSelector));
}

function isBlockBoundary(tag: string): boolean {
  return tag === "li" || tag === "blockquote" || tag === "pre" || /^h[1-6]$/.test(tag);
}

function isTableStructure(tag: string | null): boolean {
  return ["table", "thead", "tbody", "tr", "th", "td"].includes(tag ?? "");
}

function closestAssistantMessage(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(ASSISTANT_MESSAGE_SELECTOR) ?? null;
}

function restoreMarkdownElements(container: HTMLElement): void {
  for (const ignored of container.querySelectorAll(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`)) {
    ignored.remove();
  }

  const marked = Array.from(container.querySelectorAll(`[${MARKDOWN_COPY_TAG_ATTRIBUTE}]`));
  for (const element of marked.toReversed()) {
    const tagName = element.getAttribute(MARKDOWN_COPY_TAG_ATTRIBUTE);
    if (!tagName) {
      continue;
    }
    const semanticElement = document.createElement(tagName);
    if (tagName !== "br") {
      semanticElement.append(...element.childNodes);
    }
    if (tagName === "ol") {
      const start = element.getAttribute(MARKDOWN_COPY_LIST_START_ATTRIBUTE);
      if (start) {
        semanticElement.setAttribute("start", start);
      }
    }
    if (tagName === "pre") {
      const language = element.getAttribute(MARKDOWN_COPY_LANGUAGE_ATTRIBUTE);
      const code = semanticElement.querySelector(":scope > code");
      if (language && code) {
        code.className = `language-${language}`;
      }
    }
    if (tagName === "th" || tagName === "td") {
      const alignment = element.getAttribute(MARKDOWN_COPY_ALIGN_ATTRIBUTE);
      if (alignment) {
        semanticElement.setAttribute("align", alignment);
      }
    }
    element.replaceWith(semanticElement);
  }

  unwrapIncompleteTables(container);

  const generatedLinks = Array.from(
    container.querySelectorAll(`[${MARKDOWN_COPY_UNWRAP_ATTRIBUTE}]`),
  );
  for (const element of generatedLinks.toReversed()) {
    element.replaceWith(...element.childNodes);
  }

  const presentational = Array.from(container.querySelectorAll("div, span"));
  for (const element of presentational.toReversed()) {
    element.replaceWith(...element.childNodes);
  }
}

function unwrapIncompleteTables(container: HTMLElement): void {
  for (const table of container.querySelectorAll("table")) {
    if (hasUsableTableColumnContract(table)) {
      continue;
    }
    const cells = Array.from(table.querySelectorAll("th, td"));
    const selectedContent = document.createDocumentFragment();
    cells.forEach((cell, index) => {
      if (index > 0) {
        selectedContent.append("\n");
      }
      selectedContent.append(...cell.childNodes);
    });
    table.replaceWith(selectedContent);
  }
}

function hasUsableTableColumnContract(table: Element): boolean {
  const headerWidth = table.querySelectorAll("thead th").length;
  return (
    headerWidth > 0 &&
    Array.from(table.querySelectorAll("tbody tr")).every(
      (row) => row.children.length <= headerWidth,
    )
  );
}
