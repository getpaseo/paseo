import { afterEach, expect, it } from "vitest";
import { MarkdownPreviewFindModel } from "./model.web";
import { findMarkdownPreviewMatches, selectedSingleLineText } from "./ranges.web";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  CSS.highlights.clear();
});

function createPreviewSurface(html: string, viewportHeight = 200) {
  const root = document.createElement("div");
  root.style.position = "relative";
  root.style.width = "360px";
  root.style.height = `${viewportHeight}px`;

  const scroll = document.createElement("div");
  scroll.dataset.testid = "markdown-preview-scroll";
  scroll.style.width = "360px";
  scroll.style.height = `${viewportHeight}px`;
  scroll.style.overflowY = "auto";

  const frame = document.createElement("div");
  frame.dataset.testid = "markdown-preview-frame";
  frame.innerHTML = html;

  scroll.append(frame);
  root.append(scroll);
  document.body.append(root);
  return { root, scroll, frame };
}

it("finds literal case-insensitive matches across inline formatting and frontmatter cells", () => {
  const { frame } = createPreviewSurface(`
    <div data-testid="markdown-front-matter">
      <div>
        <div data-paseo-markdown-tag="th">title</div>
        <div data-paseo-markdown-tag="td">Guide a.b</div>
      </div>
    </div>
    <div data-paseo-markdown-tag="p">İ😀hello <strong>A.B</strong> and axb</div>
    <div data-paseo-markdown-tag="p">line one<br>line two</div>
    <div data-paseo-markdown-tag="pre">
      <span data-paseo-markdown-tag="code"><span>const x = "a</span><span>.b";</span></span>
      <button data-paseo-markdown-ignore="true">Copy a.b</button>
    </div>
  `);

  const literal = findMarkdownPreviewMatches(frame, "a.b");
  expect(literal.limited).toBe(false);
  expect(literal.ranges.map((range) => range.toString())).toEqual(["a.b", "A.B", "a.b"]);
  expect(findMarkdownPreviewMatches(frame, "titleGuide").ranges).toEqual([]);
  expect(findMarkdownPreviewMatches(frame, "oneline").ranges).toEqual([]);
});

it("marks limited only when matches exceed the cap", () => {
  const { frame } = createPreviewSurface(
    '<div data-paseo-markdown-tag="p">needle one needle two needle three</div>',
  );

  const exact = findMarkdownPreviewMatches(frame, "needle", 3);
  expect(exact.ranges).toHaveLength(3);
  expect(exact.limited).toBe(false);

  const capped = findMarkdownPreviewMatches(frame, "needle", 2);
  expect(capped.ranges).toHaveLength(2);
  expect(capped.limited).toBe(true);
});

it("seeds only single-line selections inside the preview frame", () => {
  const { frame } = createPreviewSurface(`
    <div data-paseo-markdown-tag="p" id="first">alpha beta</div>
    <div data-paseo-markdown-tag="p" id="second">gamma</div>
  `);
  const outside = document.createElement("div");
  outside.textContent = "outside";
  document.body.append(outside);

  const selection = window.getSelection()!;
  const singleRange = document.createRange();
  singleRange.selectNodeContents(frame.querySelector("#first")!);
  selection.removeAllRanges();
  selection.addRange(singleRange);
  expect(selectedSingleLineText(frame)).toBe("alpha beta");

  const multiRange = document.createRange();
  multiRange.setStart(frame.querySelector("#first")!.firstChild!, 0);
  multiRange.setEnd(frame.querySelector("#second")!.firstChild!, 5);
  selection.removeAllRanges();
  selection.addRange(multiRange);
  expect(selectedSingleLineText(frame)).toBeNull();

  frame.innerHTML = '<div data-paseo-markdown-tag="pre">line 1\nline 2</div>';
  const preRange = document.createRange();
  preRange.selectNodeContents(frame.firstElementChild!);
  selection.removeAllRanges();
  selection.addRange(preRange);
  expect(selectedSingleLineText(frame)).toBeNull();

  const outsideRange = document.createRange();
  outsideRange.selectNodeContents(outside);
  selection.removeAllRanges();
  selection.addRange(outsideRange);
  expect(selectedSingleLineText(frame)).toBeNull();
});

it("highlights matches, scrolls offscreen occurrences into view, and flips corner when covered", () => {
  const filler = Array.from({ length: 24 }, (_, idx) => `<p>filler row ${idx}</p>`).join("");
  const { root, scroll } = createPreviewSurface(
    `<p style="margin:0; text-align:right;">top needle right</p>${filler}<p>bottom needle end</p>`,
    180,
  );

  const widget = document.createElement("div");
  widget.style.position = "absolute";
  widget.style.top = "8px";
  widget.style.right = "8px";
  widget.style.width = "300px";
  widget.style.height = "44px";
  root.append(widget);

  const model = new MarkdownPreviewFindModel({
    all: "test-md-find-all",
    active: "test-md-find-active",
  });
  model.setRootNode(root);
  model.open();
  model.setWidgetNode(widget);
  model.setSearch("needle");

  expect(model.getSnapshot()).toMatchObject({
    open: true,
    query: "needle",
    current: 1,
    total: 2,
    limited: false,
    placement: "bottom",
  });
  expect(CSS.highlights.get("test-md-find-all")?.size).toBe(2);
  expect(CSS.highlights.get("test-md-find-active")?.size).toBe(1);

  model.next();
  expect(model.getSnapshot().current).toBe(2);
  expect(scroll.scrollTop).toBeGreaterThan(0);

  model.previous();
  expect(model.getSnapshot().current).toBe(1);

  model.close();
  expect(model.getSnapshot().open).toBe(false);
  expect(CSS.highlights.has("test-md-find-all")).toBe(false);
  expect(CSS.highlights.has("test-md-find-active")).toBe(false);
  model.dispose();
});
