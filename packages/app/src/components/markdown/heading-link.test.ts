import { describe, expect, it } from "vitest";
import { markdownHeadingSlug, scrollToMarkdownHeading } from "./heading-link";

interface FakeNode {
  tagName: string;
  textContent: string | null;
  parentElement: FakeNode | null;
  open?: boolean;
  scrolled?: boolean;
  children: FakeNode[];
  querySelectorAll(selector: string): FakeNode[];
  scrollIntoView(): void;
}

function el(tag: string, text: string | null, children: FakeNode[] = []): FakeNode {
  const node: FakeNode = {
    tagName: tag.toUpperCase(),
    textContent: text,
    parentElement: null,
    children,
    querySelectorAll(selector) {
      const tags = new Set(selector.split(",").map((part) => part.trim().toUpperCase()));
      const matches: FakeNode[] = [];
      const walk = (current: FakeNode) => {
        if (tags.has(current.tagName)) matches.push(current);
        for (const child of current.children) walk(child);
      };
      for (const child of node.children) walk(child);
      return matches;
    },
    scrollIntoView() {
      node.scrolled = true;
    },
  };
  if (text == null) {
    node.textContent = children.map((child) => child.textContent ?? "").join("");
  }
  for (const child of children) child.parentElement = node;
  return node;
}

describe("markdown heading links", () => {
  it("builds GitHub-style slugs", () => {
    expect(markdownHeadingSlug("标记 A")).toBe("标记-a");
    expect(markdownHeadingSlug("Marker B")).toBe("marker-b");
    expect(markdownHeadingSlug("Hello, World!")).toBe("hello-world");
    expect(markdownHeadingSlug("一、安装")).toBe("一-安装");
    expect(markdownHeadingSlug("Foo  Bar")).toBe("foo-bar");
  });

  it("scrolls to the heading in the same markdown tree", () => {
    const link = el("a", "去标记 A");
    const paragraph = el("p", null, [link]);
    const markerA = el("h2", "标记 A");
    const markerB = el("h2", "Marker B");
    const markerB2 = el("h2", "Marker B");
    const root = el("div", null, [markerA, paragraph, markerB, markerB2]);
    const other = el("h2", "标记 A");
    el("div", null, [root, other]);

    expect(scrollToMarkdownHeading(link, "#标记-a")).toBe(true);
    expect(markerA.scrolled).toBe(true);
    expect(markerB.scrolled).toBeUndefined();

    markerA.scrolled = false;
    expect(scrollToMarkdownHeading(link, "#Marker-B")).toBe(true);
    expect(markerB.scrolled).toBe(true);

    markerB.scrolled = false;
    expect(scrollToMarkdownHeading(link, "#%E6%A0%87%E8%AE%B0-a")).toBe(true);
    expect(scrollToMarkdownHeading(link, "#marker-b-1")).toBe(true);
    expect(markerB2.scrolled).toBe(true);
    expect(markerB.scrolled).toBe(false);
    expect(other.scrolled).toBeUndefined();
  });

  it("leaves line numbers, forge numbers, and other documents alone", () => {
    const link = el("a", "x");
    el("div", null, [el("h2", "标记 A"), el("p", null, [link])]);
    expect(scrollToMarkdownHeading(link, "#L80")).toBe(false);
    expect(scrollToMarkdownHeading(link, "#12")).toBe(false);
    expect(scrollToMarkdownHeading(link, "docs/a.md#标记-a")).toBe(false);
    expect(scrollToMarkdownHeading(link, "https://example.com/docs#marker-b")).toBe(false);
  });

  it("opens a closed details element around the heading", () => {
    const hidden = el("h2", "藏在折叠里");
    const details = el("details", null, [hidden]);
    const link = el("a", "打开");
    el("div", null, [el("p", null, [link]), details]);
    expect(scrollToMarkdownHeading(link, "#藏在折叠里")).toBe(true);
    expect(hidden.scrolled).toBe(true);
    expect(details.open).toBe(true);
  });
});
