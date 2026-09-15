import { describe, expect, it } from "vitest";
import { WordStream } from "./model";

describe("word streaming", () => {
  it("buffers a network fragment until the word is complete", () => {
    const stream = new WordStream("");
    stream.receive("hel", true);
    expect(stream.advance(100)).toBe("");
    stream.receive("hello world ", true);
    expect(stream.advance(16)).toBe("hello ");
    expect(stream.advance(100)).toBe("hello world ");
  });

  it("paces a burst by words instead of releasing the network chunk", () => {
    const stream = new WordStream("");
    stream.receive("one two three four five six ", true);
    expect(stream.advance(16)).toBe("one ");
    expect(stream.advance(16)).toBe("one ");
    expect(stream.advance(17)).toBe("one two ");
    expect(stream.advance(40)).toBe("one two three ");
  });

  it("does not accumulate idle time as credit for the next burst", () => {
    const stream = new WordStream("");
    stream.advance(5000);
    stream.receive("one two three ", true);
    expect(stream.advance(16)).toBe("one ");
  });

  it("preserves history on first paint and drains the final word on completion", () => {
    const stream = new WordStream("history ");
    expect(stream.text).toBe("history ");
    stream.receive("history 👨‍👩‍👧‍👦 café", true);
    expect(stream.advance(16)).toBe("history 👨‍👩‍👧‍👦 ");
    stream.receive("history 👨‍👩‍👧‍👦 café", false);
    expect(stream.advance(100)).toBe("history 👨‍👩‍👧‍👦 café");
    expect(stream.pending).toBe(false);
  });

  it("preserves whitespace, Markdown, and Unicode exactly", () => {
    const text = "**café**\n\n- 🇺🇸\t[link](https://paseo.sh)  العربية ";
    const stream = new WordStream("");
    for (let end = 1; end <= text.length; end++) {
      stream.receive(text.slice(0, end), true);
      const visible = stream.advance(16);
      expect(text.startsWith(visible)).toBe(true);
      expect(visible === "" || /\s$/u.test(visible)).toBe(true);
    }
    stream.receive(text, false);
    stream.advance(250);
    expect(stream.text).toBe(text);
  });

  it("replaces edited text without replaying the old buffer", () => {
    const stream = new WordStream("old text");
    stream.receive("new", true);
    expect(stream.text).toBe("new");
    expect(stream.pending).toBe(false);
  });

  it("keeps a large burst paced until every word is visible", () => {
    const text = "word ".repeat(200);
    const stream = new WordStream("");
    stream.receive(text, true);
    let previous = "";
    for (let frame = 0; frame < 800; frame++) {
      const visible = stream.advance(1000 / 60);
      expect(visible.length - previous.length).toBeLessThanOrEqual(5);
      previous = visible;
    }
    expect(stream.text).toBe(text);
    expect(stream.pending).toBe(false);
  });

  it("paces queued words even when the provider finishes immediately after its last chunk", () => {
    const stream = new WordStream("");
    stream.receive("one two three four", false);
    expect(stream.text).toBe("");
    expect(stream.advance(16)).toBe("one ");
    expect(stream.advance(250)).toBe("one two ");
    expect(stream.advance(250)).toBe("one two three ");
    expect(stream.advance(250)).toBe("one two three four");
    expect(stream.pending).toBe(false);
  });
});

it("reports how long each released word owns the front", () => {
  const stream = new WordStream("");
  stream.receive("one two three four five six ", true);
  stream.advance(16);
  // Five words remain: the front moves faster, but never faster than a frame.
  expect(stream.spanMs).toBe(33);
  stream.receive("one two three four five six ", false);
  while (stream.pending) stream.advance(250);
  expect(stream.spanMs).toBe(60);
});

it("never turns a delayed frame into a simultaneous word burst", () => {
  const stream = new WordStream("");
  stream.receive("one two three four five six seven eight nine ten ", true);
  expect(stream.advance(250)).toBe("one ");
  expect(stream.advance(250)).toBe("one two ");
});
