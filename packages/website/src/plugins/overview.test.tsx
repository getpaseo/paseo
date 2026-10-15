import registry from "../../e2e/registry.fixture.json";
import { PluginTile } from "./plugin-tile";
import { PluginCard } from "./plugin-card";
import type { Plugin } from "./registry";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { describe, expect, it } from "vitest";
import corpus from "../../../protocol/tests/fixtures/plugin-overview.json";
import { PluginOverview } from "./overview";

type Element = DefaultTreeAdapterMap["element"];
function elements(html: string): Element[] {
  const result: Element[] = [];
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node) result.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html));
  return result;
}
function render(markdown: string) {
  return renderToStaticMarkup(<PluginOverview>{markdown}</PluginOverview>);
}
function attribute(element: Element, name: string) {
  return element.attrs.find((attr) => attr.name === name)?.value;
}
const allowedTags = new Set([
  "div",
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "del",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

describe("plugin overview security corpus", () => {
  it.each(corpus)("$name", ({ markdown, links, images }) => {
    const nodes = elements(render(markdown));
    expect(
      nodes.filter((node) => !allowedTags.has(node.tagName)).map((node) => node.tagName),
    ).toEqual([]);
    expect(
      nodes.flatMap((node) => node.attrs).filter((attr) => /^on|^style$|^srcdoc$/i.test(attr.name)),
    ).toEqual([]);
    const anchors = nodes.filter((node) => node.tagName === "a");
    expect(anchors.map((node) => attribute(node, "href"))).toEqual(links);
    for (const anchor of anchors) {
      expect(attribute(anchor, "rel")).toBe("noopener noreferrer nofollow");
      expect(attribute(anchor, "target")).toBe("_blank");
    }
    expect(
      nodes.filter((node) => node.tagName === "img").map((node) => attribute(node, "src")),
    ).toEqual(images);
  });

  it.each(corpus)("preserves $name inside code spans and fences", ({ markdown }) => {
    for (const code of [
      `\`${markdown.replaceAll("\n", " ")}\``,
      `\`\`\`html\n${markdown}\n\`\`\``,
    ]) {
      const nodes = elements(render(code));
      expect(
        nodes.filter((node) => ["a", "img", "script", "iframe", "svg"].includes(node.tagName)),
      ).toEqual([]);
      const text = nodes
        .filter((node) => node.tagName === "code")
        .flatMap((node) => node.childNodes)
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
      expect(text.trim()).toBe(
        code.startsWith("```html") ? markdown : markdown.replaceAll("\n", " "),
      );
    }
  });

  it("keeps long untrusted input inert", () => {
    const nodes = elements(
      render("a".repeat(100_000) + "\n\n" + "[click](javascript:alert(1)) ".repeat(1_000)),
    );
    expect(nodes.filter((node) => ["a", "img", "script"].includes(node.tagName))).toEqual([]);
  });
});

describe("registry images", () => {
  it.each([
    "http://example.com/x",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "vbscript:msgbox(1)",
    "./icon.png",
    "//example.com/x",
  ])("does not load %s in cards or icons", (url) => {
    const plugin = { ...registry.plugins[0], icon: url, media: [url] } as Plugin;
    for (const component of [
      createElement(PluginTile, { plugin, size: "sm" }),
      createElement(PluginCard, { plugin }),
    ]) {
      expect(
        elements(renderToStaticMarkup(component)).filter((node) => node.tagName === "img"),
      ).toEqual([]);
    }
  });
});

it("uses the first HTTPS screenshot when an earlier screenshot is rejected", () => {
  const source = "https://example.com/screenshot.png";
  const plugin = {
    ...registry.plugins[0],
    icon: undefined,
    media: ["data:image/png;base64,AAAA", source],
  } as Plugin;
  const nodes = elements(renderToStaticMarkup(createElement(PluginCard, { plugin })));
  expect(
    nodes.filter((node) => node.tagName === "img").map((node) => attribute(node, "src")),
  ).toEqual([source]);
});
