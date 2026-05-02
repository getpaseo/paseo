import { describe, expect, it } from "vitest";
import { isCursorOnFirstLine, isCursorOnLastLine } from "./cursor-line-position";

describe("isCursorOnFirstLine", () => {
  it("returns true for empty string at position 0", () => {
    expect(isCursorOnFirstLine("", 0)).toBe(true);
  });

  it("returns true for single-line string at any position", () => {
    expect(isCursorOnFirstLine("hello", 0)).toBe(true);
    expect(isCursorOnFirstLine("hello", 3)).toBe(true);
    expect(isCursorOnFirstLine("hello", 5)).toBe(true);
  });

  it("returns true when cursor is before the first newline", () => {
    expect(isCursorOnFirstLine("foo\nbar", 0)).toBe(true);
    expect(isCursorOnFirstLine("foo\nbar", 3)).toBe(true);
  });

  it("returns false when cursor is on or after the first newline", () => {
    // Position 4 is right after "\n", which is on the second line.
    expect(isCursorOnFirstLine("foo\nbar", 4)).toBe(false);
    expect(isCursorOnFirstLine("foo\nbar", 7)).toBe(false);
  });

  it("returns false when text begins with a newline and cursor is past it", () => {
    expect(isCursorOnFirstLine("\nabc", 1)).toBe(false);
  });

  it("returns true when text begins with a newline and cursor is at position 0", () => {
    expect(isCursorOnFirstLine("\nabc", 0)).toBe(true);
  });

  it("CRLF: \\r counts as part of the first line, the \\n is the boundary", () => {
    // "foo\r\nbar" — first line is "foo\r" (positions 0..4), \n at index 4.
    expect(isCursorOnFirstLine("foo\r\nbar", 0)).toBe(true);
    expect(isCursorOnFirstLine("foo\r\nbar", 4)).toBe(true);
    expect(isCursorOnFirstLine("foo\r\nbar", 5)).toBe(false);
  });
});

describe("isCursorOnLastLine", () => {
  it("returns true for empty string at position 0", () => {
    expect(isCursorOnLastLine("", 0)).toBe(true);
  });

  it("returns true for single-line string at any position", () => {
    expect(isCursorOnLastLine("hello", 0)).toBe(true);
    expect(isCursorOnLastLine("hello", 3)).toBe(true);
    expect(isCursorOnLastLine("hello", 5)).toBe(true);
  });

  it("returns true when cursor is after the last newline", () => {
    expect(isCursorOnLastLine("foo\nbar", 4)).toBe(true);
    expect(isCursorOnLastLine("foo\nbar", 7)).toBe(true);
  });

  it("returns false when cursor is before the last newline", () => {
    expect(isCursorOnLastLine("foo\nbar", 0)).toBe(false);
    expect(isCursorOnLastLine("foo\nbar", 3)).toBe(false);
  });

  it("returns true at end-of-string even when string ends with newline", () => {
    // Empty trailing line is still "last line".
    expect(isCursorOnLastLine("foo\n", 4)).toBe(true);
  });

  it("returns false on a middle line of a 3-line string", () => {
    // "a\nb\nc" — middle line "b" is at index 2.
    expect(isCursorOnLastLine("a\nb\nc", 2)).toBe(false);
    expect(isCursorOnLastLine("a\nb\nc", 3)).toBe(false);
    expect(isCursorOnLastLine("a\nb\nc", 4)).toBe(true);
  });

  it("CRLF: \\n is the boundary, so \\r right before \\n is not on last line", () => {
    // "foo\r\nbar" — last line starts at index 5.
    expect(isCursorOnLastLine("foo\r\nbar", 4)).toBe(false);
    expect(isCursorOnLastLine("foo\r\nbar", 5)).toBe(true);
    expect(isCursorOnLastLine("foo\r\nbar", 8)).toBe(true);
  });

  it("consecutive newlines: each empty line is its own line", () => {
    // "a\n\nb" — three lines: "a", "", "b". Index 2 is on the empty middle line.
    expect(isCursorOnLastLine("a\n\nb", 2)).toBe(false);
    expect(isCursorOnLastLine("a\n\nb", 3)).toBe(true);
  });
});
