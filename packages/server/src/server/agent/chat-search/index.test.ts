import { expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { searchTimeline } from "./index.js";

function rows(items: AgentTimelineItem[]) {
  return items.map((item, index) => ({ item, seq: index + 1, timestamp: "2026-09-12T00:00:00Z" }));
}

it("returns source locations for formatted assistant text and literal user text", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "user_message", text: "hello **world**" },
      { type: "assistant_message", text: "İ😀hello **world** and hello *world*" },
      {
        type: "assistant_message",
        text: "[hello &amp; world](https://example.com)",
        messageId: "separate",
      },
    ]),
    query: "hello world",
  });
  expect(result).toEqual({
    locations: [{ seq: 2, role: "assistant", count: 2 }],
    nextCursor: null,
  });
});

it("finds code and literal punctuation without searching tools, reasoning, or task state", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "assistant_message", text: "```ts\nconst value = 'a.b';\n```" },
      { type: "reasoning", text: "a.b" },
      { type: "todo", items: [{ text: "a.b", completed: false }] },
      { type: "user_message", text: "axb" },
      { type: "user_message", text: "a.b" },
    ]),
    query: "a.b",
  });
  expect(result.locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
    { seq: 5, role: "user", count: 1 },
  ]);
});

it("bounds results and resumes without losing locations", async () => {
  const source = rows(
    Array.from({ length: 202 }, () => ({ type: "user_message", text: "target" })),
  );
  const first = await searchTimeline({ rows: source, query: "target" });
  expect(first.locations).toHaveLength(200);
  expect(first.nextCursor).toBe(200);
  const second = await searchTimeline({ rows: source, query: "target", cursor: first.nextCursor! });
  expect(second).toEqual({
    locations: [
      { seq: 201, role: "user", count: 1 },
      { seq: 202, role: "user", count: 1 },
    ],
    nextCursor: null,
  });
});

it("finds ordinary Markdown entities and line breaks without requiring identical parsers", async () => {
  const source = rows([{ type: "assistant_message", text: "hello &amp; **world**\nnext line" }]);
  expect((await searchTimeline({ rows: source, query: "hello & world" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "world next" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
});

it("counts occurrences per rendered block rather than across block boundaries", async () => {
  const source = rows([
    { type: "assistant_message", text: "target one\n\ntarget two\n\n- target three\n- end target" },
    { type: "user_message", text: "TARGET target" },
  ]);
  expect((await searchTimeline({ rows: source, query: "target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 4 },
    { seq: 2, role: "user", count: 2 },
  ]);
  expect((await searchTimeline({ rows: source, query: "end target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "two target" })).locations).toEqual([]);
  // Rendered text never runs from the end of one block into the start of the next, so
  // neither does a match, however contiguous the Markdown source looks.
  expect((await searchTimeline({ rows: source, query: "one target" })).locations).toEqual([]);
});

it("indexes visible MathML symbols for inline and display LaTeX without misclassifying currency or shell dollars", async () => {
  const source = rows([
    {
      type: "assistant_message",
      text: [
        "只在 $2^k$ 翻倍点建 Key，当亲和阈值 $\\theta \\in [0.5, 1.0]$ 时，读区间 $[\\text{floorLevel}(\\theta N_w), N_w]$ 满足 **ReadSet $\\le 2$** 且 $\\alpha < \\beta$。",
        "",
        "$$",
        "\\begin{aligned}",
        "|\\text{ReadSet}(N_w)| &\\le 2 \\quad \\forall \\theta \\in [0.5, 1.0]",
        "\\end{aligned}",
        "$$",
        "",
        "Pricing stays literal: $50 to $100/yr, `$HOME`, $PATH:$HOME, and https://example.com/$raw$/path.",
      ].join("\n"),
    },
  ]);

  expect((await searchTimeline({ rows: source, query: "α" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "α<β" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "θ" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 3 },
  ]);
  expect((await searchTimeline({ rows: source, query: "≤" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 2 },
  ]);
  // Hidden TeX commands are not visible in rendered MathML and must not inflate candidate counts.
  expect((await searchTimeline({ rows: source, query: "\\alpha" })).locations).toEqual([]);
  // Currency, shell variables, and URLs remain literal searchable text.
  expect((await searchTimeline({ rows: source, query: "$50 to $100/yr" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "$PATH:$HOME" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect(
    (await searchTimeline({ rows: source, query: "https://example.com/$raw$/path" })).locations,
  ).toEqual([{ seq: 1, role: "assistant", count: 1 }]);
});

it("treats display math as a separate block boundary matching browser DOM groups", async () => {
  const source = rows([
    {
      type: "assistant_message",
      text: "before $$\\theta + 1$$ after",
    },
  ]);

  expect((await searchTimeline({ rows: source, query: "θ+1" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "before θ" })).locations).toEqual([]);
  expect((await searchTimeline({ rows: source, query: "1 after" })).locations).toEqual([]);
});
