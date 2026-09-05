import { afterEach, describe, expect, it } from "vitest";
import { findTextRanges } from "./text-ranges";

const mounted: HTMLElement[] = [];

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  mounted.push(host);
  return host;
}

function matchedText(ranges: readonly Range[]): string[] {
  return ranges.map((range) => range.toString());
}

afterEach(() => {
  for (const host of mounted.splice(0)) {
    host.remove();
  }
});

describe("findTextRanges", () => {
  it("returns nothing for an empty query", () => {
    const root = mount("<p>Deployment pipeline</p>");
    expect(findTextRanges({ roots: [root], query: "" })).toEqual([]);
  });

  it("finds every occurrence regardless of case", () => {
    const root = mount("<p>Pipeline, PIPELINE and pipeline.</p>");

    const ranges = findTextRanges({ roots: [root], query: "PiPeLiNe" });

    expect(matchedText(ranges)).toEqual(["Pipeline", "PIPELINE", "pipeline"]);
  });

  it("matches across the spans a markdown renderer emits", () => {
    const root = mount("<div>deploy <span>the </span><span>pipe</span>line now</div>");

    const ranges = findTextRanges({ roots: [root], query: "the pipeline" });

    expect(matchedText(ranges)).toEqual(["the pipeline"]);
  });

  it("anchors a match that ends on a node boundary inside the node it ends in", () => {
    const root = mount("<div><span>alpha</span><span>beta</span></div>");
    const [alpha] = Array.from(root.querySelectorAll("span"));

    const [range] = findTextRanges({ roots: [root], query: "alpha" });

    expect(range?.endContainer).toBe(alpha?.firstChild);
    expect(range?.endOffset).toBe(5);
  });

  it("does not count overlapping occurrences twice", () => {
    const root = mount("<p>aaaa</p>");

    expect(findTextRanges({ roots: [root], query: "aa" })).toHaveLength(2);
  });

  it("skips script and style contents", () => {
    const root = mount(
      "<div><style>.pipeline { color: red; }</style><script>const pipeline = 1;</script><p>pipeline</p></div>",
    );

    const ranges = findTextRanges({ roots: [root], query: "pipeline" });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer.parentElement?.tagName).toBe("P");
  });

  it("skips subtrees the markdown renderer marks as ignored", () => {
    const root = mount(
      '<div><span data-paseo-markdown-ignore="true">pipeline marker</span><p>pipeline body</p></div>',
    );

    const ranges = findTextRanges({ roots: [root], query: "pipeline" });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer.parentElement?.tagName).toBe("P");
  });

  // The mermaid fence paints its source until its runtime answers, and permanently when
  // the source policy rejects it; the transcript index projects the fence as empty.
  it("skips subtrees marked as unsearchable", () => {
    const root = mount(
      '<div><span data-paseo-find-ignore="true">pipeline diagram source</span><p>pipeline body</p></div>',
    );

    const ranges = findTextRanges({ roots: [root], query: "pipeline" });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startContainer.parentElement?.tagName).toBe("P");
  });

  it("locates matches spread across many text nodes", () => {
    const words = Array.from({ length: 200 }, (_, index) =>
      index % 10 === 0 ? "<span>pipeline </span>" : "<span>filler </span>",
    );
    const root = mount(`<div>${words.join("")}</div>`);

    const ranges = findTextRanges({ roots: [root], query: "pipeline" });

    expect(ranges).toHaveLength(20);
    expect(matchedText(ranges).every((text) => text === "pipeline")).toBe(true);
    expect(ranges.at(-1)?.startContainer.parentElement).toBe(root.querySelectorAll("span")[190]);
  });

  it("searches each root separately and never matches across two of them", () => {
    const host = mount("<div id='first'>deploy pipe</div><div id='second'>line ready</div>");
    const roots = Array.from(host.querySelectorAll("div"));

    expect(findTextRanges({ roots, query: "pipeline" })).toEqual([]);
    expect(matchedText(findTextRanges({ roots, query: "e" }))).toEqual(["e", "e", "e", "e"]);
  });

  it("returns ranges in document order across roots", () => {
    const host = mount("<div>first hit</div><div>second hit</div>");
    const roots = Array.from(host.querySelectorAll("div"));

    const ranges = findTextRanges({ roots, query: "hit" });

    expect(ranges).toHaveLength(2);
    expect(ranges[0]?.startContainer.parentElement).toBe(roots[0]);
    expect(ranges[1]?.startContainer.parentElement).toBe(roots[1]);
  });
});

// Turkish dotted capital I lowercases to "i" plus a combining dot above, so the folded
// text is longer than what the DOM holds.
const DOTTED_CAPITAL_I = "\u0130";
const DOTTED_LOWERCASE_I = "i\u0307";
// Deseret, to keep an astral-plane fold honest: both forms are surrogate pairs.
const DESERET_LONG_I = "\u{10400}";
const DESERET_LONG_I_LOWER = "\u{10428}";

describe("findTextRanges with folds that change length", () => {
  it("matches an uppercase spelling that folds longer than itself", () => {
    const root = mount(`<p>${DOTTED_CAPITAL_I}stanbul</p>`);

    const ranges = findTextRanges({ roots: [root], query: `${DOTTED_LOWERCASE_I}stanbul` });

    expect(matchedText(ranges)).toEqual([`${DOTTED_CAPITAL_I}stanbul`]);
  });

  it("does not match a spelling the fold does not produce", () => {
    const root = mount(`<p>${DOTTED_CAPITAL_I}stanbul</p>`);

    // The fold adds the combining dot rather than dropping it, so a dotless query is a
    // different string, the same way Chromium's own find treats it.
    expect(findTextRanges({ roots: [root], query: "istanbul" })).toEqual([]);
  });

  it("folds the query too, so an uppercase query finds lowercase text", () => {
    const root = mount(`<p>${DOTTED_LOWERCASE_I}stanbul</p>`);

    const ranges = findTextRanges({ roots: [root], query: `${DOTTED_CAPITAL_I}stanbul` });

    expect(matchedText(ranges)).toEqual([`${DOTTED_LOWERCASE_I}stanbul`]);
  });

  it("covers the whole source character when a match lands inside an expanded fold", () => {
    const root = mount(`<p>${DOTTED_CAPITAL_I}stanbul</p>`);

    const [range] = findTextRanges({ roots: [root], query: "i" });

    expect(range?.startOffset).toBe(0);
    expect(range?.endOffset).toBe(1);
    expect(range?.toString()).toBe(DOTTED_CAPITAL_I);
  });

  it("keeps offsets correct after an expanded fold earlier in the node", () => {
    const root = mount(`<p>${DOTTED_CAPITAL_I}stanbul</p>`);

    const [range] = findTextRanges({ roots: [root], query: "bul" });

    expect(range?.startOffset).toBe(5);
    expect(range?.endOffset).toBe(8);
    expect(range?.toString()).toBe("bul");
  });

  it("matches across nodes when the fold expands at the boundary", () => {
    const root = mount(`<div><span>${DOTTED_CAPITAL_I}</span><span>stanbul</span></div>`);
    const [first, second] = Array.from(root.querySelectorAll("span"));

    const [range] = findTextRanges({ roots: [root], query: `${DOTTED_LOWERCASE_I}stanbul` });

    expect(range?.startContainer).toBe(first?.firstChild);
    expect(range?.endContainer).toBe(second?.firstChild);
    expect(range?.toString()).toBe(`${DOTTED_CAPITAL_I}stanbul`);
  });

  it("keeps surrogate-pair offsets intact", () => {
    const root = mount(`<p>${DESERET_LONG_I}${DESERET_LONG_I}ok</p>`);

    const ranges = findTextRanges({ roots: [root], query: DESERET_LONG_I_LOWER });

    expect(ranges).toHaveLength(2);
    expect([ranges[0]?.startOffset, ranges[0]?.endOffset]).toEqual([0, 2]);
    expect([ranges[1]?.startOffset, ranges[1]?.endOffset]).toEqual([2, 4]);
    expect(matchedText(ranges)).toEqual([DESERET_LONG_I, DESERET_LONG_I]);
  });
});
