import { describe, expect, it } from "vitest";
import { formatTerminalTranscript } from "./format-terminal-transcript";

describe("formatTerminalTranscript", () => {
  it.each([
    ["first\nsecond", "first second "],
    ["first\r\nsecond", "first second "],
    ["first\rsecond", "first second "],
    ["\n  hello \r\n", "hello "],
    ["héllo 日本語", "héllo 日本語 "],
  ])("formats %j as %j", (input, expected) => {
    expect(formatTerminalTranscript(input)).toBe(expected);
  });

  it.each(["", "  ", "\r\n"])("returns null for %j", (input) => {
    expect(formatTerminalTranscript(input)).toBeNull();
  });
});
