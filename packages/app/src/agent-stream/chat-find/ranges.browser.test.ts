import { afterEach, expect, it } from "vitest";
import { findMessageMatches, findRenderedMatches } from "./ranges.web";

afterEach(() => {
  document.body.replaceChildren();
});
function content(html: string) {
  const row = document.createElement("div");
  row.innerHTML = `<div data-message-text="true">${html}</div>`;
  document.body.append(row);
  return row;
}
function message(messageId: string, ...blocks: string[]) {
  const root = document.createElement("div");
  for (const block of blocks) {
    const row = document.createElement("div");
    row.dataset.messageId = messageId;
    row.innerHTML = `<div data-message-text="true"><div data-paseo-markdown-tag="p">${block}</div></div>`;
    root.append(row);
  }
  document.body.append(root);
  return root;
}
it("collects a message's occurrences across its block rows in row order", () => {
  const root = message("message-1", "alpha one", "beta", "alpha two");
  const other = document.createElement("div");
  other.dataset.messageId = "message-2";
  other.innerHTML =
    '<div data-message-text="true"><div data-paseo-markdown-tag="p">alpha three</div></div>';
  root.append(other);
  expect(findMessageMatches(root, "message-1", "alpha").map((range) => range.toString())).toEqual([
    "alpha",
    "alpha",
  ]);
  expect(
    findMessageMatches(root, "message-1", "alpha").map(
      (range) => range.startContainer.parentElement?.textContent,
    ),
  ).toEqual(["alpha one", "alpha two"]);
  expect(findMessageMatches(root, "message-2", "alpha")).toHaveLength(1);
  expect(findMessageMatches(null, "message-1", "alpha")).toEqual([]);
});
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

it("keeps semantic Markdown paragraphs separate while finding inline matches", () => {
  const row = content(
    "<p>İ😀hello <strong>world</strong>; hello <em>world</em>.</p><p>another paragraph</p>",
  );
  expect(findRenderedMatches(row, "hello world").map((range) => range.toString())).toEqual([
    "hello world",
    "hello world",
  ]);
  expect(findRenderedMatches(row, ".another")).toEqual([]);
});

function pluginRow(html: string) {
  const row = document.createElement("div");
  row.dataset.pluginRow = "true";
  row.dataset.messageId = "message-1";
  row.innerHTML = html;
  document.body.append(row);
  return row;
}

it("searches a plugin row that sets no text marker, bounding matches by view", () => {
  const row = pluginRow(
    "<div><div>Prompt</div><div>find <span>this</span> needle</div><div>needle</div><button>needle</button></div>",
  );
  expect(findRenderedMatches(row, "needle").map((range) => range.toString())).toEqual([
    "needle",
    "needle",
  ]);
  expect(findRenderedMatches(row, "Promptfind")).toEqual([]);
  expect(findRenderedMatches(row, "find this needle")).toHaveLength(1);
  expect(findMessageMatches(row.parentElement, "message-1", "needle")).toHaveLength(2);
});

it("leaves rows without the plugin marker limited to marked message text", () => {
  const row = document.createElement("div");
  row.innerHTML = "<div>needle</div>";
  document.body.append(row);
  expect(findRenderedMatches(row, "needle")).toEqual([]);
});

it("counts only drawn text in a plugin row, including an opened popover", () => {
  const row = pluginRow(
    '<div><span>visible needle</span><div hidden>hidden needle</div><div style="display:none">display needle</div><span style="visibility:hidden">visibility needle</span><span style="opacity:0">transparent needle</span><div popover="manual">popover needle</div></div>',
  );
  expect(findRenderedMatches(row, "needle").map((range) => range.toString())).toEqual(["needle"]);
  row.querySelector<HTMLElement>("[popover]")!.showPopover();
  expect(findRenderedMatches(row, "needle")).toHaveLength(2);
});

it("keeps text around nested plugin blocks in separate occurrences", () => {
  const row = pluginRow("<div>alpha <div>details</div>beta</div><div>gamma <div></div>delta</div>");
  expect(findRenderedMatches(row, "alpha beta")).toEqual([]);
  expect(findRenderedMatches(row, "gamma delta")).toEqual([]);
  expect(findRenderedMatches(row, "details").map((range) => range.toString())).toEqual(["details"]);
  expect(findRenderedMatches(row, "beta").map((range) => range.toString())).toEqual(["beta"]);
});
