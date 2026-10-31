import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createStreamingMarkdownSplitter, splitStreamingMarkdown } from "./streaming";

describe("native streaming Markdown", () => {
  it("keeps completed messages together for selection", () => {
    const text = "First.\n\nSecond.\n\nThird.";
    expect(splitStreamingMarkdown(text, false)).toEqual({ head: text, tail: "" });
  });
  it("commits earlier blocks only after the following source line is complete", () => {
    expect(splitStreamingMarkdown("First.\n\nSecond", true).head).toBe("");
    expect(splitStreamingMarkdown("First.\n\nSecond\n", true)).toEqual({
      head: "First.\n\n",
      tail: "Second\n",
    });
  });
  it.each([
    "- one\n\n- two\n",
    "> first\n> second\n",
    "Title\n---\n",
    "```mermaid\ngraph LR\nA --> B\n```\n",
    "- one\n  - nested\n\n    paragraph\n",
    "    indented code\n\n    still code\n",
    "| A | B |\n| --- | --- |\n| x | y |\n",
    "```ts\nconst value = 1;\n```\n",
    "<div>\nbody\n\nmore\n</div>\n",
    "[label]\n\n[label]: /target\n",
    "[label]: /target\n\n[label]\n",
  ])("keeps an unfinished construct together: %s", (block) => {
    const prefix = "Introduction.\n\n";
    const source = prefix + block;
    const split = splitStreamingMarkdown(source, true);
    expect(split.head.length).toBeLessThanOrEqual(prefix.length);
    expect(split.head + split.tail).toBe(source);
    let previous = 0;
    for (let end = 0; end <= source.length; end++) {
      const prefixSplit = splitStreamingMarkdown(source.slice(0, end), true);
      expect(prefixSplit.head.length, `prefix ${end} of ${source}`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = prefixSplit.head.length;
    }
  });
  it("preserves the indentation that controls fence content and list continuation", () => {
    for (const tail of ["   ```ts\n   const n = 1;\n", "   - first\n     continued\n"]) {
      expect(splitStreamingMarkdown(`Intro.\n\n${tail}`, true)).toEqual({
        head: "Intro.\n\n",
        tail,
      });
    }
  });
  it("keeps unresolved references and HTML in the tail even after later blocks", () => {
    for (const block of ["[label]", "[label]: /target", "<div>body</div>"]) {
      expect(splitStreamingMarkdown(`Intro.\n\n${block}\n\nNext.\n\nEnd.\n`, true).head).toBe(
        "Intro.\n\n",
      );
    }
  });
  it("never retreats or loses source across every prefix of mixed Markdown", () => {
    const fixture = readFileSync(new URL("./streaming.fixture.md", import.meta.url), "utf8");
    let previous = 0;
    for (let end = 0; end <= fixture.length; end++) {
      const text = fixture.slice(0, end);
      const { head, tail } = splitStreamingMarkdown(text, true);
      expect(head.length, `prefix ${end}`).toBeGreaterThanOrEqual(previous);
      expect(head + tail).toBe(text);
      previous = head.length;
    }
    expect(previous).toBeGreaterThan(1000);
  }, 15000);
  it("finds the same boundary incrementally as a full parse of every prefix", () => {
    const fixture = readFileSync(new URL("./streaming.fixture.md", import.meta.url), "utf8");
    const sources = [
      fixture,
      "Intro.\n\n[label]\n\nNext.\n\n[label]: /target\n\nEnd.\n",
      "Intro.\n\n- one\n\n  continued\n\nAfter.\n\n<div>\nbody\n</div>\n\nTail.\n",
    ];
    for (const source of sources) {
      const split = createStreamingMarkdownSplitter();
      for (let end = 0; end <= source.length; end++) {
        const text = source.slice(0, end);
        const completeLines = text.slice(0, text.lastIndexOf("\n") + 1);
        expect(split(completeLines), `prefix ${end}`).toBe(
          splitStreamingMarkdown(completeLines, true).head.length,
        );
      }
    }
  }, 15000);
  it("parses only the source after the settled head", () => {
    const split = createStreamingMarkdownSplitter();
    const blocks = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}.\n\n`);
    split(blocks.join(""));
    const settled = split(`${blocks.join("")}Next.\n\n`);
    expect(settled).toBe(blocks.join("").length);
    expect(splitStreamingMarkdown(`${blocks.join("")}Next.\n\n`, true, settled).head.length).toBe(
      settled,
    );
  });
  it("starts over when the source no longer extends the settled head", () => {
    const split = createStreamingMarkdownSplitter();
    expect(split("First.\n\nSecond.\n")).toBe("First.\n\n".length);
    expect(split("Other.\n\nText.\n")).toBe("Other.\n\n".length);
  });
});
