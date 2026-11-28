import { describe, expect, test } from "vitest";

import { isOmpPlaceholderNarration } from "./narration.js";

describe("isOmpPlaceholderNarration", () => {
  test.each([".", ".\n\n", ". . .", "..", "…", "。", "·", "——", ". ", " \n\t "])(
    "treats %j as placeholder narration",
    (text) => {
      expect(isOmpPlaceholderNarration(text)).toBe(true);
    },
  );

  test.each(["Hello.", "OK", "2 lines.", "a.", "Running tests", "-"])(
    "keeps %j as real narration",
    (text) => {
      expect(isOmpPlaceholderNarration(text)).toBe(false);
    },
  );

  test("ignores non-string input", () => {
    expect(isOmpPlaceholderNarration(undefined)).toBe(false);
    expect(isOmpPlaceholderNarration(null)).toBe(false);
    expect(isOmpPlaceholderNarration(42)).toBe(false);
  });
});
