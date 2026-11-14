import { describe, expect, it } from "vitest";
import { MARKDOWN_DOCUMENT_ATTRIBUTE } from "./document";
import { scrollToMarkdownHeading } from "./heading-link";

interface FakeNode {
  tagName: string;
  textContent: string | null;
  parentElement: FakeNode | null;
  open?: boolean;
  scrolled?: boolean;
  children: FakeNode[];
  attributes: string[];
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): FakeNode[];
  scrollIntoView(): void;
}

function el(
  tag: string,
  text: string | null,
  children: FakeNode[] = [],
  attributes: string[] = [],
): FakeNode {
  const node: FakeNode = {
    tagName: tag.toUpperCase(),
    textContent: text,
    parentElement: null,
    children,
    attributes,
    hasAttribute(name) {
      return node.attributes.includes(name);
    },
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

/** One rendered Markdown document: the boundary a `#heading` link may search. */
function markdownDocument(...children: FakeNode[]): FakeNode {
  return el("div", null, children, [MARKDOWN_DOCUMENT_ATTRIBUTE]);
}

function scrolled(nodes: FakeNode[]): FakeNode[] {
  return nodes.filter((node) => node.scrolled === true);
}

function reset(nodes: FakeNode[]): void {
  for (const node of nodes) node.scrolled = undefined;
}

function link(text = "跳转"): FakeNode {
  return el("a", text);
}

describe("markdown heading links", () => {
  it("resolves GitHub-style slugs through the click path", () => {
    const headings = [
      el("h1", "标记 A"),
      el("h2", "Marker B"),
      el("h2", "Hello, World!"),
      el("h2", "一、安装"),
      el("h3", "Foo  Bar"),
    ];
    const anchor = link();
    markdownDocument(...headings, el("p", null, [anchor]));

    const cases: [string, FakeNode][] = [
      ["#标记-a", headings[0]],
      ["#%E6%A0%87%E8%AE%B0-a", headings[0]],
      ["#Marker-B", headings[1]],
      ["#hello-world", headings[2]],
      ["#一-安装", headings[3]],
      ["#foo-bar", headings[4]],
    ];
    for (const [fragment, expected] of cases) {
      expect(scrollToMarkdownHeading(anchor, fragment)).toBe(true);
      expect(scrolled(headings)).toEqual([expected]);
      reset(headings);
    }
  });

  it("keeps the second heading with a repeated name reachable", () => {
    const first = el("h2", "Marker B");
    const second = el("h2", "Marker B");
    const anchor = link();
    markdownDocument(first, second, el("p", null, [anchor]));

    expect(scrollToMarkdownHeading(anchor, "#marker-b")).toBe(true);
    expect(scrolled([first, second])).toEqual([first]);
    reset([first, second]);

    expect(scrollToMarkdownHeading(anchor, "#marker-b-1")).toBe(true);
    expect(scrolled([first, second])).toEqual([second]);
  });

  it("reserves a generated suffix that a later heading needs", () => {
    const literal = el("h2", "Foo 1");
    const first = el("h2", "Foo");
    const second = el("h2", "Foo");
    const anchor = link();
    markdownDocument(literal, first, second, el("p", null, [anchor]));
    const all = [literal, first, second];

    expect(scrollToMarkdownHeading(anchor, "#foo-1")).toBe(true);
    expect(scrolled(all)).toEqual([literal]);
    reset(all);

    expect(scrollToMarkdownHeading(anchor, "#foo")).toBe(true);
    expect(scrolled(all)).toEqual([first]);
    reset(all);

    expect(scrollToMarkdownHeading(anchor, "#foo-2")).toBe(true);
    expect(scrolled(all)).toEqual([second]);
  });

  it("searches the whole document, not the nearest block with a heading", () => {
    const quoted = el("h2", "引用标题");
    const body = el("h2", "正文标题");
    const anchor = link();
    markdownDocument(el("blockquote", null, [quoted, el("p", null, [anchor])]), body);

    expect(scrollToMarkdownHeading(anchor, "#正文标题")).toBe(true);
    expect(scrolled([quoted, body])).toEqual([body]);
    reset([quoted, body]);

    expect(scrollToMarkdownHeading(anchor, "#引用标题")).toBe(true);
    expect(scrolled([quoted, body])).toEqual([quoted]);
  });

  it("does not reach into another document", () => {
    const anchor = link();
    const elsewhere = el("h2", "别处标题");
    el("div", null, [markdownDocument(el("p", null, [anchor])), markdownDocument(elsewhere)]);

    expect(scrollToMarkdownHeading(anchor, "#别处标题")).toBe(false);
    expect(elsewhere.scrolled).toBeUndefined();
  });

  it("refuses a link that is not inside a markdown document", () => {
    const anchor = link();
    el("div", null, [el("h2", "标题"), el("p", null, [anchor])]);

    expect(scrollToMarkdownHeading(anchor, "#标题")).toBe(false);
  });

  it("leaves line numbers, forge numbers, and other documents alone", () => {
    const anchor = link();
    const heading = el("h2", "标题");
    el("div", null, [markdownDocument(heading, el("p", null, [anchor]))]);

    expect(scrollToMarkdownHeading(anchor, "#L80")).toBe(false);
    expect(scrollToMarkdownHeading(anchor, "#12")).toBe(false);
    expect(scrollToMarkdownHeading(anchor, "docs/a.md#标题")).toBe(false);
    expect(scrollToMarkdownHeading(anchor, "https://example.com/docs#标题")).toBe(false);
    expect(heading.scrolled).toBeUndefined();
  });

  it("opens a closed details element around the heading", () => {
    const hidden = el("h2", "藏在折叠里");
    const details = el("details", null, [hidden]);
    const anchor = link("打开");
    markdownDocument(el("p", null, [anchor]), details);

    expect(scrollToMarkdownHeading(anchor, "#藏在折叠里")).toBe(true);
    expect(hidden.scrolled).toBe(true);
    expect(details.open).toBe(true);
  });
});
