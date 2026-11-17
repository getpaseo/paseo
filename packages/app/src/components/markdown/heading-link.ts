// Local bundle counterpart: paseo-patches/md-heading-jump.js. The installed app
// injects that file because it cannot be rebuilt. It keeps the older
// nearest-ancestor-with-headings search: the released renderer has no document
// marker to look for. Everything else (slug rules, line-number and forge
// fragments, details reveal) must stay in step with this file.

import { MARKDOWN_DOCUMENT_ATTRIBUTE } from "./document";

interface MarkdownElement {
  tagName: string;
  textContent: string | null;
  hasAttribute(name: string): boolean;
  parentElement: MarkdownElement | null;
  open?: boolean;
  querySelectorAll(selector: string): ArrayLike<MarkdownElement>;
  scrollIntoView?(options: ScrollIntoViewOptions): void;
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";
const LINE_FRAGMENT = /^l\d+(?:c\d+)?(?:-l?\d+(?:c\d+)?)?$/i;
const SEPARATORS =
  /[\s~`!@#$%^&*()+=[\]{}|\\;:"'“”‘’–—<>«»…,.?/、。，：；！？（）【】《》「」『』·]+/g;

function withoutControls(text: string): string {
  let stripped = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 31) stripped += text.charAt(index);
  }
  return stripped;
}

function headingSlug(text: string): string {
  return withoutControls(
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase(),
  )
    .replace(SEPARATORS, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function headingFragment(url: string): string | null {
  if (!url.startsWith("#")) return null;
  let fragment = url.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  fragment = fragment.trim().toLowerCase();
  if (!fragment || fragment.includes("/")) return null;
  if (LINE_FRAGMENT.test(fragment) || /^\d+$/.test(fragment)) return null;
  return fragment;
}

function revealHeading(heading: MarkdownElement): void {
  let parent = heading.parentElement;
  while (parent) {
    if (parent.tagName === "DETAILS") parent.open = true;
    parent = parent.parentElement;
  }
  heading.scrollIntoView?.({ block: "start", inline: "nearest" });
}

/**
 * Resolves a fragment against the document's headings. Repeated base names keep
 * counting up until a name no earlier heading claimed is free, so a heading
 * literally called `Foo 1` cannot take the id a later `Foo` needs.
 */
function headingInList(
  headings: ArrayLike<MarkdownElement>,
  fragment: string,
): MarkdownElement | null {
  const claimed = new Set<string>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading) continue;
    const base = headingSlug(heading.textContent ?? "");
    if (!base) continue;
    let id = base;
    let suffix = 0;
    while (claimed.has(id)) {
      suffix += 1;
      id = `${base}-${suffix}`;
    }
    claimed.add(id);
    if (id === fragment) return heading;
  }
  return null;
}

function markdownDocument(anchor: MarkdownElement): MarkdownElement | null {
  let node = anchor.parentElement;
  while (node) {
    if (node.hasAttribute(MARKDOWN_DOCUMENT_ATTRIBUTE)) return node;
    node = node.parentElement;
  }
  return null;
}

export function scrollToMarkdownHeading(anchor: MarkdownElement, url: string): boolean {
  const fragment = headingFragment(url);
  if (!fragment) return false;
  const document = markdownDocument(anchor);
  if (!document) return false;
  const heading = headingInList(document.querySelectorAll(HEADINGS), fragment);
  if (!heading) return false;
  revealHeading(heading);
  return true;
}
