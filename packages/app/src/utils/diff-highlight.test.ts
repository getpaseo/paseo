import { describe, expect, it } from "vitest";
import { highlightDiffLines } from "./diff-highlight";
import { buildLineDiff, parseUnifiedDiff, type DiffLine } from "./tool-call-parsers";

function joinTokens(line: DiffLine): string {
  return (line.tokens ?? []).map((token) => token.text).join("");
}

describe("highlightDiffLines", () => {
  it("attaches tokens to add/remove/context lines for a supported language", () => {
    const diff = buildLineDiff("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;");
    const result = highlightDiffLines(diff, "/repo/src/index.ts");

    const context = result.find((line) => line.type === "context");
    const remove = result.find((line) => line.type === "remove");
    const add = result.find((line) => line.type === "add");

    expect(context?.tokens).toBeDefined();
    expect(remove?.tokens).toBeDefined();
    expect(add?.tokens).toBeDefined();
    // Tokens reconstruct the code with the diff marker excluded.
    expect(joinTokens(context as DiffLine)).toBe("const a = 1;");
    expect(joinTokens(remove as DiffLine)).toBe("const b = 2;");
    expect(joinTokens(add as DiffLine)).toBe("const b = 3;");
    // A keyword token is recognised (proves real highlighting, not pass-through).
    expect(add?.tokens?.some((token) => token.style === "keyword")).toBe(true);
  });

  it("highlights a Codex-style unified diff with bare @@ headers (no line ranges)", () => {
    const unified = ["@@", "-const x = 1;", "+const x = 2;", " const y = 3;"].join("\n");
    const result = highlightDiffLines(parseUnifiedDiff(unified), "/repo/a.ts");

    const remove = result.find((line) => line.type === "remove");
    const add = result.find((line) => line.type === "add");
    const context = result.find((line) => line.type === "context");
    expect(joinTokens(remove as DiffLine)).toBe("const x = 1;");
    expect(joinTokens(add as DiffLine)).toBe("const x = 2;");
    expect(joinTokens(context as DiffLine)).toBe("const y = 3;");
    expect(result.find((line) => line.type === "header")?.tokens).toBeUndefined();
  });

  it("returns lines unchanged for an unsupported language", () => {
    const diff = buildLineDiff("a", "b");
    const result = highlightDiffLines(diff, "/repo/notes.unknownext");
    expect(result).toBe(diff);
    expect(result.every((line) => line.tokens === undefined)).toBe(true);
  });

  it("returns lines unchanged when there is no file path", () => {
    const diff = buildLineDiff("a", "b");
    expect(highlightDiffLines(diff, undefined)).toBe(diff);
  });
});
