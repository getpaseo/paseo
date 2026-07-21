import { describe, expect, it } from "vitest";
import { applyFileEol, detectFileEol, normalizeToLf } from "./line-endings";

describe("detectFileEol", () => {
  it("chooses CRLF when it is the dominant ending", () => {
    expect(detectFileEol("a\r\nb\r\nc\nd")).toBe("\r\n");
  });

  it("chooses LF for a tie and for content without newlines", () => {
    expect(detectFileEol("a\r\nb\nc")).toBe("\n");
    expect(detectFileEol("single line")).toBe("\n");
  });
});

describe("normalizeToLf and applyFileEol", () => {
  it("round-trips CRLF content through the editor representation", () => {
    const original = "a\r\nb\r\n";
    const draft = normalizeToLf(original);

    expect(draft).toBe("a\nb\n");
    expect(applyFileEol(draft, detectFileEol(original))).toBe(original);
  });

  it("normalizes lone carriage returns to LF", () => {
    expect(normalizeToLf("a\rb\r\nc")).toBe("a\nb\nc");
  });
});
