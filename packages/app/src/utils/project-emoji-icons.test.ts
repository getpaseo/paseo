import { describe, expect, it } from "vitest";
import { searchProjectEmojiIcons } from "./project-emoji-icons";

describe("searchProjectEmojiIcons", () => {
  it("shows a useful default selection", () => {
    const results = searchProjectEmojiIcons("");

    expect(results.length).toBeGreaterThan(40);
    expect(results.some((entry) => entry.emoji === "\u{1F4BC}")).toBe(true);
  });

  it("finds monetary icons by dollar and finance aliases", () => {
    const dollarResults = searchProjectEmojiIcons("dollar");
    const financeResults = searchProjectEmojiIcons("finance");

    expect(dollarResults.some((entry) => entry.emoji === "\u{1F4B2}")).toBe(true);
    expect(financeResults.some((entry) => entry.emoji === "\u{1F4B5}")).toBe(true);
  });

  it("supports multi-word keyword searches", () => {
    const results = searchProjectEmojiIcons("money bank");

    expect(results.some((entry) => entry.emoji === "\u{1F3E6}")).toBe(true);
  });
});
