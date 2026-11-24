import { describe, expect, it } from "vitest";
import { highlightDiffLines, mergeDiffTokensAndSegments } from "./diff-highlight";
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

  it("highlights a Dockerfile diff using the filename", () => {
    const diff = buildLineDiff("FROM alpine:3.21", "FROM alpine:3.22");
    const result = highlightDiffLines(diff, "/repo/docker/Dockerfile");

    expect(result.find((line) => line.type === "add")?.tokens).toContainEqual({
      text: "FROM",
      style: "keyword",
    });
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

  it("preserves word-level segments alongside syntax tokens and merges them cleanly", () => {
    const diff = buildLineDiff('routeA: "PBH (M_i=352)"', 'routeA: "PBH (M_i=353)"');
    const highlighted = highlightDiffLines(diff, "/repo/src/theoryContentEn.ts");
    const remove = highlighted.find((line) => line.type === "remove") as DiffLine;
    const add = highlighted.find((line) => line.type === "add") as DiffLine;

    expect(remove.tokens).toBeDefined();
    expect(remove.segments).toBeDefined();
    expect(add.tokens).toBeDefined();
    expect(add.segments).toBeDefined();

    const removeRuns = mergeDiffTokensAndSegments(remove.tokens ?? [], remove.segments);
    const addRuns = mergeDiffTokensAndSegments(add.tokens ?? [], add.segments);

    expect(removeRuns.map((run) => run.text).join("")).toBe('routeA: "PBH (M_i=352)"');
    expect(addRuns.map((run) => run.text).join("")).toBe('routeA: "PBH (M_i=353)"');

    // Only the changed number inside the string token is marked changed, while keeping string style.
    const changedRemove = removeRuns.filter((run) => run.changed);
    const changedAdd = addRuns.filter((run) => run.changed);
    expect(changedRemove).toEqual([{ text: "352", style: "string", changed: true }]);
    expect(changedAdd).toEqual([{ text: "353", style: "string", changed: true }]);
  });
});
