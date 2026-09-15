import { afterEach, expect, it } from "vitest";
import { findRenderedMatches } from "./ranges.web";

afterEach(() => {
  document.body.replaceChildren();
});
function content(html: string) {
  const row = document.createElement("div");
  row.innerHTML = `<div data-message-text="true">${html}</div>`;
  document.body.append(row);
  return row;
}
it("finds each actual occurrence across inline formatting with original Unicode offsets", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p">İ😀hello <strong>world</strong> then <em>hello</em> world</div>',
  );
  const matches = findRenderedMatches(row, "hello world");
  expect(matches.map((range) => range.toString())).toEqual(["hello world", "hello world"]);
  expect(matches[0]!.startOffset).toBe(3);
  expect(matches[0]!.compareBoundaryPoints(Range.START_TO_START, matches[1]!)).toBe(-1);
});
it("ignores controls, keeps block boundaries, and preserves literal code punctuation", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p">first</div><div data-paseo-markdown-tag="p">second</div><div data-paseo-markdown-tag="pre"><span>const a</span><span>.b</span><button>copy a.b</button><span data-paseo-markdown-ignore="true">a.b</span></div>',
  );
  expect(findRenderedMatches(row, "firstsecond")).toEqual([]);
  expect(findRenderedMatches(row, "a.b").map((range) => range.toString())).toEqual(["a.b"]);
});
it("matches whitespace across text nodes without inspecting hidden link destinations", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p"><a href="https://example.com/hidden">hello &amp; world</a>\nline</div>',
  );
  expect(findRenderedMatches(row, "hidden")).toEqual([]);
  expect(findRenderedMatches(row, "world line").map((range) => range.toString())).toEqual([
    "world\nline",
  ]);
});
