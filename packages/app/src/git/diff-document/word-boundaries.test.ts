import { CharCategory, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { wordRangeAtOffset } from "./word-boundaries";

describe("diff word boundaries", () => {
  it("selects the identifier under the offset", () => {
    expect(wordRangeAtOffset("alpha bravo charlie", 8)).toEqual({ start: 6, end: 11 });
  });

  it("selects the surrounding whitespace when the offset is inside a run of spaces", () => {
    expect(wordRangeAtOffset("alpha   bravo", 6)).toEqual({ start: 5, end: 8 });
  });

  it("selects a run of punctuation without merging it into neighboring words", () => {
    expect(wordRangeAtOffset("call(foo, bar)", 4)).toEqual({ start: 4, end: 5 });
    expect(wordRangeAtOffset("call(foo, bar)", 6)).toEqual({ start: 5, end: 8 });
    expect(wordRangeAtOffset("fn()", 3)).toEqual({ start: 2, end: 4 });
    expect(wordRangeAtOffset("foo.bar", 3)).toEqual({ start: 3, end: 4 });
    expect(wordRangeAtOffset("foo.bar", 5)).toEqual({ start: 4, end: 7 });
  });

  it("selects the final word when the offset reaches the end of the line", () => {
    expect(wordRangeAtOffset("alpha bravo", 11)).toEqual({ start: 6, end: 11 });
    expect(wordRangeAtOffset("alpha bravo", 99)).toEqual({ start: 6, end: 11 });
  });

  it("selects the leading word when the offset is clamped at the start", () => {
    expect(wordRangeAtOffset("alpha bravo", 0)).toEqual({ start: 0, end: 5 });
  });

  it("keeps combining sequences and emoji clusters whole", () => {
    const combining = "ai\u0301b";
    expect(wordRangeAtOffset(combining, 1)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAtOffset(combining, 2)).toEqual({ start: 0, end: 4 });

    const emoji = "hi 👨‍👩‍👧‍👦 there";
    const emojiStart = emoji.indexOf("👨");
    expect(wordRangeAtOffset(emoji, emojiStart)).toEqual({
      start: emojiStart,
      end: emojiStart + "👨‍👩‍👧‍👦".length,
    });
  });

  it("treats tabs as whitespace and returns an empty range for empty content", () => {
    expect(wordRangeAtOffset("\tfoo", 0)).toEqual({ start: 0, end: 1 });
    expect(wordRangeAtOffset("", 0)).toEqual({ start: 0, end: 0 });
  });

  it("matches CodeMirror word runs for offsets inside a word", () => {
    const content = "alpha bravo charlie";
    const state = EditorState.create({ doc: content });
    for (const offset of [0, 2, 8, 14, 18]) {
      const word = state.wordAt(offset);
      expect(word).not.toBeNull();
      expect(wordRangeAtOffset(content, offset)).toEqual({ start: word!.from, end: word!.to });
    }
  });

  it("classifies leading graphemes with CodeMirror character categories", () => {
    const categorize = EditorState.create({ doc: "" }).charCategorizer(0);
    const clusters = ["a", "1", "_", "中", "👨‍👩‍👧‍👦", "\u0301", "\ufe0f", "\u00a0"];
    for (const cluster of clusters) {
      const isWord = categorize(cluster) === CharCategory.Word;
      expect(wordRangeAtOffset(`${cluster}x`, 0)).toEqual({
        start: 0,
        end: isWord ? cluster.length + 1 : cluster.length,
      });
    }
  });
});
