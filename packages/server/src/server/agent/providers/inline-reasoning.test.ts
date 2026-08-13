import { describe, expect, test } from "vitest";

import {
  createInlineReasoningState,
  flushInlineReasoning,
  splitInlineReasoning,
} from "./inline-reasoning.js";

function collect(chunks: string[]): { kind: string; text: string }[] {
  const state = createInlineReasoningState();
  const segments: { kind: string; text: string }[] = [];
  for (const chunk of chunks) {
    segments.push(...splitInlineReasoning(state, chunk));
  }
  segments.push(...flushInlineReasoning(state));
  return segments;
}

describe("splitInlineReasoning", () => {
  test("splits a complete reasoning block out of one chunk", () => {
    expect(collect(["<think>secret plan</think>Hello there"])).toEqual([
      { kind: "reasoning", text: "secret plan" },
      { kind: "text", text: "Hello there" },
    ]);
  });

  test("passes plain text through untouched", () => {
    expect(collect(["Just waiting on you."])).toEqual([
      { kind: "text", text: "Just waiting on you." },
    ]);
  });

  test("handles a marker split across chunk boundaries", () => {
    expect(collect(["<thi", "nk>hidden</thi", "nk>visible"])).toEqual([
      { kind: "reasoning", text: "hidden" },
      { kind: "text", text: "visible" },
    ]);
  });

  test("streams reasoning incrementally so partial thinking renders live", () => {
    // Each chunk emits as it arrives rather than buffering the whole block.
    expect(collect(["<think>step one ", "step two</think>", "answer"])).toEqual([
      { kind: "reasoning", text: "step one " },
      { kind: "reasoning", text: "step two" },
      { kind: "text", text: "answer" },
    ]);
  });

  test("keeps text before an opening marker", () => {
    expect(collect(["prefix<think>mid</think>suffix"])).toEqual([
      { kind: "text", text: "prefix" },
      { kind: "reasoning", text: "mid" },
      { kind: "text", text: "suffix" },
    ]);
  });

  test("handles multiple reasoning blocks in one stream", () => {
    expect(collect(["<think>a</think>one<think>b</think>two"])).toEqual([
      { kind: "reasoning", text: "a" },
      { kind: "text", text: "one" },
      { kind: "reasoning", text: "b" },
      { kind: "text", text: "two" },
    ]);
  });

  test("flushes an unterminated reasoning block as reasoning", () => {
    expect(collect(["<think>never closed"])).toEqual([{ kind: "reasoning", text: "never closed" }]);
  });

  test("flushes a dangling partial marker as text instead of dropping it", () => {
    expect(collect(["all done<thi"])).toEqual([
      { kind: "text", text: "all done" },
      { kind: "text", text: "<thi" },
    ]);
  });

  test("does not treat a lone angle bracket as a marker", () => {
    expect(collect(["a < b and c > d"])).toEqual([{ kind: "text", text: "a < b and c > d" }]);
  });

  test("emits nothing for an empty chunk", () => {
    const state = createInlineReasoningState();
    expect(splitInlineReasoning(state, "")).toEqual([]);
  });
});
