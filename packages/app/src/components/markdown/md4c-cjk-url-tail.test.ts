import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import { describe, expect, it } from "vitest";
import { prepareMarkdownSource } from "./source";

// Reproduces the remainder of #9743: md4c's permissive autolink keeps every
// non-ASCII character in a URL's path, query or fragment and trims only ASCII
// punctuation, so CJK punctuation after a path becomes part of the link.
describe("md4c permissive autolink tail", () => {
  it.each([
    [
      "上线至 https://content.worldinspirelab.com/intake。",
      "https://content.worldinspirelab.com/intake",
      "。",
    ],
    ["见 https://example.com/a/b，还有", "https://example.com/a/b", "，还有"],
    ["见 https://example.com/a（说明）以及", "https://example.com/a", "（说明）以及"],
    ["见 https://example.com/?q=1、下一个", "https://example.com/?q=1", "、下一个"],
  ])("ends the link before CJK punctuation: %s", async (source, url, after) => {
    const tree = await parseMarkdown(prepareMarkdownSource(source).render(), { latexMath: false });
    const children = tree.children?.[0]?.children ?? [];
    const link = children.find((node) => node.type === "Link");
    expect(link?.attributes?.url).toBe(url);
    expect(children.at(-1)).toEqual({ type: "Text", content: after });
  });

  it("keeps CJK letters in a path", async () => {
    const tree = await parseMarkdown(
      prepareMarkdownSource("见 https://zh.wikipedia.org/wiki/人工智能 ok").render(),
      { latexMath: false },
    );
    expect(tree.children?.[0]?.children?.[1]?.attributes?.url).toBe(
      "https://zh.wikipedia.org/wiki/人工智能",
    );
  });
});
