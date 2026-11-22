import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "./streaming";

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

  it("keeps an open display equation in the tail while it is the last block", () => {
    // The equation's closing $$ has not streamed in; the block is still
    // mutable and belongs to the tail.
    expect(splitStreamingMarkdown("Intro.\n\n$$ a\n\n", true)).toEqual({
      head: "Intro.\n\n",
      tail: "$$ a\n\n",
    });
  });

  it("keeps a closed display equation in the head once it is complete", () => {
    expect(splitStreamingMarkdown("Intro.\n\n$$ a $$\n\nMore.\n", true).head).toBe(
      "Intro.\n\n$$ a $$\n\n",
    );
  });

  it("pulls an open display equation back out of the head when a later block completes", () => {
    // The $$ block is a complete paragraph, but its equation is open. It must
    // not freeze in the head as a literal $$; the next complete block after it
    // is what earns the head the earlier blocks.
    const split = splitStreamingMarkdown("Intro.\n\n$$ a\n\nMore.\n", true);
    expect(split.head).toBe("Intro.\n\n");
    expect(split.tail).toBe("$$ a\n\nMore.\n");
  });

  it("never retreats or loses source across every prefix of streaming math", () => {
    const source =
      "Intro $x^2$ done.\n\n$$\na = b\n c = d\n$$\n\nAfter $y$ and $$ z $$ blocks.\n\n$$ open";
    let previous = 0;
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      const { head, tail } = splitStreamingMarkdown(text, true);
      expect(head.length, `prefix ${end}`).toBeGreaterThanOrEqual(previous);
      expect(head + tail).toBe(text);
      previous = head.length;
    }
    // The finished head still holds both completed blocks; only the trailing
    // block and its unfinished open equation stay mutable.
    expect(previous).toBeGreaterThan(30);
  });
});
