import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy-score.js";

function ranked(query: string, words: string[]): string[] {
  return words
    .map((word) => ({ word, score: fuzzyScore(query, word) }))
    .filter((entry): entry is { word: string; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.word);
}

describe("fuzzyScore", () => {
  it("rewards a matching prefix over a scattered match", () => {
    expect(ranked("chi", ["chip.ts", "chat-input.tsx"])).toEqual(["chip.ts", "chat-input.tsx"]);
  });

  it("rewards separator and camel-case boundaries", () => {
    expect(ranked("ci", ["chat-input.tsx", "chronicle.ts"])).toEqual([
      "chat-input.tsx",
      "chronicle.ts",
    ]);
    expect(ranked("fb", ["fooBar.ts", "foobar.ts"])).toEqual(["fooBar.ts", "foobar.ts"]);
  });

  it("keeps a contiguous run ahead of a gapped one", () => {
    expect(ranked("rend", ["renderer.ts", "renew-day.ts"])).toEqual([
      "renderer.ts",
      "renew-day.ts",
    ]);
  });

  it("ranks a full match above a prefix of a longer name", () => {
    expect(ranked("index", ["index", "index.ts"])).toEqual(["index", "index.ts"]);
  });

  it("rejects a first match that starts mid-word", () => {
    expect(fuzzyScore("foo", "xfoo.ts")).toBeNull();
    expect(fuzzyScore("foo", "bar-foo.ts")).not.toBeNull();
  });

  it("rejects characters that do not appear in order", () => {
    expect(fuzzyScore("abc", "cba")).toBeNull();
    expect(fuzzyScore("abcd", "abc")).toBeNull();
  });

  it("matches case-insensitively and still sees camel-case boundaries", () => {
    expect(fuzzyScore("CHAT", "chatInput.ts")).not.toBeNull();
    expect(ranked("ci", ["chatInput.ts", "chatin.ts"])).toEqual(["chatInput.ts", "chatin.ts"]);
  });

  it("caps both strings at the VSCode length limit", () => {
    // VSCode only looks at the first 128 code units. Callers that care about a long
    // path's tail (the filename) must pass that tail, not the whole path.
    const trailingNeedle = `${"a".repeat(200)}-needle`;
    expect(fuzzyScore("needle", trailingNeedle)).toBeNull();
    expect(fuzzyScore("needle", `${"a".repeat(200)}-needle`.slice(-128))).not.toBeNull();
    expect(fuzzyScore("a".repeat(200), trailingNeedle)).not.toBeNull();
  });
});
