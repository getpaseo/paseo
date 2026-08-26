import { describe, expect, it } from "vitest";

export function formatPastedTextSummary(lineCount: number, byteSize: number): string {
  const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  const sizeLabel = byteSize < 1024 ? `${byteSize} B` : `${(byteSize / 1024).toFixed(1)} KB`;
  return `${lineLabel} • ${sizeLabel}`;
}

export function shouldCollapsePastedText(
  text: string,
  options?: { minChars?: number; minLines?: number },
): boolean {
  const minChars = options?.minChars ?? 400;
  const minLines = options?.minLines ?? 10;
  return text.length >= minChars || text.split("\n").length >= minLines;
}

export function getTruncatedPreview(
  text: string,
  isExpanded: boolean,
  options?: { maxLines?: number; maxChars?: number },
): string {
  if (isExpanded) return text;
  const maxLines = options?.maxLines ?? 8;
  const maxChars = options?.maxChars ?? 400;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join("\n")}...`;
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}...`;
  }
  return text;
}

describe("Pasted Text Collapse Logic", () => {
  it("formats line and byte size summary correctly", () => {
    expect(formatPastedTextSummary(1, 50)).toBe("1 line • 50 B");
    expect(formatPastedTextSummary(45, 2048)).toBe("45 lines • 2.0 KB");
  });

  it("detects large pasted text based on characters and line thresholds", () => {
    expect(shouldCollapsePastedText("short text")).toBe(false);
    expect(shouldCollapsePastedText("a".repeat(450))).toBe(true);
    expect(shouldCollapsePastedText("line\n".repeat(12))).toBe(true);
  });

  it("truncates preview when collapsed and shows full text when expanded", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
    const preview = getTruncatedPreview(longText, false, { maxLines: 5 });
    expect(preview.split("\n")).toHaveLength(5);
    expect(preview).toContain("Line 5...");

    const full = getTruncatedPreview(longText, true);
    expect(full).toBe(longText);
  });
});
