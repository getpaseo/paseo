// Same rules as paseo-patches/md-heading-jump.js. The installed bundle injects
// that file because the desktop app cannot be rebuilt. Keep the two copies aligned.

interface HeadingNode {
  tagName: string;
  textContent: string | null;
  parentElement: HeadingNode | null;
  open?: boolean;
  querySelectorAll(selector: string): ArrayLike<HeadingNode>;
  scrollIntoView?(options: ScrollIntoViewOptions): void;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
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

export function markdownHeadingSlug(text: string): string {
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

function revealHeading(heading: HeadingNode): void {
  let parent = heading.parentElement;
  while (parent) {
    if (parent.tagName === "DETAILS") parent.open = true;
    parent = parent.parentElement;
  }
  heading.scrollIntoView?.({ block: "start", inline: "nearest" });
}

function headingInList(headings: ArrayLike<HeadingNode>, fragment: string): HeadingNode | null {
  const seen = new Map<string, number>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading) continue;
    const base = markdownHeadingSlug(heading.textContent ?? "");
    if (!base) continue;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    const id = occurrence === 0 ? base : `${base}-${occurrence}`;
    if (id === fragment) return heading;
  }
  return null;
}

function markdownRoot(anchor: HeadingNode): HeadingNode | null {
  let node = anchor.parentElement;
  while (node) {
    if (!HEADING_TAGS.has(node.tagName)) {
      const headings = node.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (headings.length) return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function scrollToMarkdownHeading(anchor: HeadingNode, url: string): boolean {
  try {
    const fragment = headingFragment(url);
    const root = fragment ? markdownRoot(anchor) : null;
    if (!fragment || !root) return false;
    const heading = headingInList(root.querySelectorAll("h1, h2, h3, h4, h5, h6"), fragment);
    if (!heading) return false;
    revealHeading(heading);
    return true;
  } catch {
    return false;
  }
}
