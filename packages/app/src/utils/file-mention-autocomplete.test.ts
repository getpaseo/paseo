import { describe, expect, it } from "vitest";
import { applyFileMentionReplacement, findActiveFileMention } from "./file-mention-autocomplete";

describe("findActiveFileMention", () => {
  it("detects mentions at the start of input", () => {
    const mention = findActiveFileMention({
      text: "@src/components",
      cursorIndex: "@src/components".length,
    });
    expect(mention).toEqual({
      start: 0,
      end: "@src/components".length,
      query: "src/components",
    });
  });

  it("detects mentions in the middle of input using cursor position", () => {
    const text = 'read "@src/com" before merging';
    const cursorIndex = text.indexOf('"') + 9;
    const mention = findActiveFileMention({
      text,
      cursorIndex,
    });
    expect(mention).toEqual({
      start: text.indexOf("@"),
      end: cursorIndex,
      query: "src/com",
    });
  });

  it("returns null when cursor is outside the mention token", () => {
    const text = "please review @src/components now";
    const mention = findActiveFileMention({
      text,
      cursorIndex: text.length,
    });
    expect(mention).toBeNull();
  });

  it("returns null when @ at start is followed by a delimiter", () => {
    const mention = findActiveFileMention({
      text: "@ ",
      cursorIndex: 2,
    });
    expect(mention).toBeNull();
  });
});

describe("applyFileMentionReplacement", () => {
  it("replaces only the active @query segment with a quoted relative path", () => {
    const text = "open @src/com next";
    const next = applyFileMentionReplacement({
      text,
      mention: { start: 5, end: 13, query: "src/com" },
      relativePath: "src/components/chat.tsx",
    });
    expect(next).toBe('open "src/components/chat.tsx" next');
  });

  it("escapes double quotes in replacement path", () => {
    const text = "@foo";
    const next = applyFileMentionReplacement({
      text,
      mention: { start: 0, end: 4, query: "foo" },
      relativePath: 'src/"quoted".ts',
    });
    expect(next).toBe('"src/\\"quoted\\".ts"');
  });
});
