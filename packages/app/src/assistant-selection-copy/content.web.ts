import TurndownService from "turndown";
import {
  createMarkdownClipboardContent,
  type MarkdownClipboardContent,
} from "@/utils/rich-clipboard";
import { MARKDOWN_COPY_IGNORE_ATTRIBUTE, MARKDOWN_COPY_TAG_ATTRIBUTE } from "./markup";

const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
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
  container.append(range.cloneContents());
  restoreMarkdownElements(container);

  const markdown = turndown.turndown(container.innerHTML).trim();
  return markdown ? createMarkdownClipboardContent(markdown) : null;
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
    semanticElement.append(...element.childNodes);
    element.replaceWith(semanticElement);
  }

  const presentational = Array.from(container.querySelectorAll("div, span"));
  for (const element of presentational.toReversed()) {
    element.replaceWith(...element.childNodes);
  }
}
