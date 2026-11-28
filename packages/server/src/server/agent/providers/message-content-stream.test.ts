import { describe, expect, test } from "vitest";
import { MessageContentStream } from "./message-content-stream.js";

describe("MessageContentStream", () => {
  test("buffers later text behind an active thinking block until thinking ends", () => {
    const stream = new MessageContentStream();

    expect(stream.update({ type: "thinking_start", contentIndex: 0 })).toEqual([]);
    expect(stream.update({ type: "thinking_delta", contentIndex: 0, delta: "plan" })).toEqual([
      { type: "thinking", text: "plan" },
    ]);
    expect(stream.update({ type: "text_start", contentIndex: 1 })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 1, delta: "Answer" })).toEqual([]);
    expect(stream.update({ type: "thinking_delta", contentIndex: 0, delta: " done." })).toEqual([
      { type: "thinking", text: " done." },
    ]);
    expect(stream.update({ type: "thinking_end", contentIndex: 0 })).toEqual([
      { type: "text", text: "Answer" },
    ]);
    expect(stream.update({ type: "text_delta", contentIndex: 1, delta: "!" })).toEqual([
      { type: "text", text: "!" },
    ]);
    expect(stream.update({ type: "text_end", contentIndex: 1 })).toEqual([]);
  });

  test("buffers later thinking behind an active text block until text ends", () => {
    const stream = new MessageContentStream();

    expect(stream.update({ type: "text_start", contentIndex: 0 })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 0, delta: "fail lou" })).toEqual([
      { type: "text", text: "fail lou" },
    ]);
    expect(stream.update({ type: "thinking_start", contentIndex: 1 })).toEqual([]);
    expect(stream.update({ type: "thinking_delta", contentIndex: 1, delta: "All green." })).toEqual(
      [],
    );
    expect(stream.update({ type: "thinking_end", contentIndex: 1 })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 0, delta: "dly" })).toEqual([
      { type: "text", text: "dly" },
    ]);
    expect(stream.update({ type: "text_end", contentIndex: 0 })).toEqual([
      { type: "thinking", text: "All green." },
    ]);
  });

  test("does not block later text behind toolcall events at an earlier index", () => {
    const stream = new MessageContentStream();

    expect(stream.update({ type: "toolcall_start", contentIndex: 0 })).toEqual([]);
    expect(
      stream.update({ type: "toolcall_delta", contentIndex: 0, delta: '{"cmd":"ls"}' }),
    ).toEqual([]);
    expect(stream.update({ type: "text_start", contentIndex: 1 })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 1, delta: "Immediate" })).toEqual([
      { type: "text", text: "Immediate" },
    ]);
  });

  test("flushes all buffered blocks in index order on finish and resets state", () => {
    const stream = new MessageContentStream();

    expect(stream.update({ type: "thinking_start", contentIndex: 0 })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 2, delta: "second" })).toEqual([]);
    expect(stream.update({ type: "text_delta", contentIndex: 1, delta: "first" })).toEqual([]);

    expect(stream.finish()).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(stream.finish()).toEqual([]);
  });

  test("passes through deltas directly when contentIndex is absent or already completed", () => {
    const stream = new MessageContentStream();

    expect(stream.update({ type: "text_delta", delta: "direct" })).toEqual([
      { type: "text", text: "direct" },
    ]);
    expect(stream.update({ type: "thinking_start", contentIndex: 0 })).toEqual([]);
    expect(stream.update({ type: "thinking_end", contentIndex: 0 })).toEqual([]);
    expect(stream.update({ type: "thinking_delta", contentIndex: 0, delta: "late" })).toEqual([
      { type: "thinking", text: "late" },
    ]);
  });
});
