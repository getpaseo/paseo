import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  createMarkdownClipboardContent,
  type MarkdownClipboardContent,
} from "@/utils/rich-clipboard";
import {
  MARKDOWN_COPY_IGNORE_ATTRIBUTE,
  MARKDOWN_COPY_LANGUAGE_ATTRIBUTE,
  MARKDOWN_COPY_LIST_START_ATTRIBUTE,
  MARKDOWN_COPY_TAG_ATTRIBUTE,
  MARKDOWN_COPY_UNWRAP_ATTRIBUTE,
} from "./markup";

const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
});
turndown.use(gfm);
turndown.addRule("gfmStrikethrough", {
  filter: ["del", "s"],
  replacement: (content) => `~~${content}~~`,
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const item = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
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

  const container = document.createElement("div");
  container.append(wrapSelectionWithAncestors(range, startMessage));
  restoreMarkdownElements(container);

  const markdown = turndown.turndown(container.innerHTML).trim();
  return markdown ? createMarkdownClipboardContent(markdown) : null;
}

function wrapSelectionWithAncestors(range: Range, message: Element): Node {
  let selected: Node = range.cloneContents();
  let ancestor =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

  while (ancestor && ancestor !== message) {
    const wrapper = ancestor.cloneNode(false) as Element;
    wrapper.append(selected);
    selected = wrapper;
    ancestor = ancestor.parentElement;
  }

  return selected;
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
    element.replaceWith(semanticElement);
  }

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
