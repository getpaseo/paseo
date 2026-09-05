import { describe, expect, it } from "vitest";
import {
  formatPastedTextSummary,
  shouldCollapsePastedText,
  PASTE_COLLAPSE_MIN_CHARS,
  PASTE_COLLAPSE_MIN_LINES,
} from "../composer/attachments/pasted-text";

describe("Pasted Text Collapse Logic", () => {
  it("formats line and byte size summary correctly via formatPastedTextSummary", () => {
    expect(formatPastedTextSummary(1, 50)).toBe("1 line • 50 B");
    expect(formatPastedTextSummary(45, 2048)).toBe("45 lines • 2.0 KB");
  });

  it("detects large pasted text based on characters and line thresholds", () => {
    expect(shouldCollapsePastedText("short text")).toBe(false);
    expect(shouldCollapsePastedText("a".repeat(PASTE_COLLAPSE_MIN_CHARS + 10))).toBe(true);
    expect(shouldCollapsePastedText("line\n".repeat(PASTE_COLLAPSE_MIN_LINES + 2))).toBe(true);
  });

  it("respects custom options for collapse thresholds", () => {
    expect(shouldCollapsePastedText("abc", { minChars: 3 })).toBe(true);
    expect(shouldCollapsePastedText("a\nb", { minLines: 2 })).toBe(true);
    expect(shouldCollapsePastedText("a\nb", { minLines: 5, minChars: 100 })).toBe(false);
  });
});
