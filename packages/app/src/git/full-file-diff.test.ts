import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { buildReviewAttachmentSnapshot } from "@/review/store";
import { buildFullFileDiff, diffFileSignature, splitFileLines } from "./full-file-diff";

type DiffHunk = ParsedDiffFile["hunks"][number];

function makeFile(hunks: DiffHunk[], overrides: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return {
    path: "src/example.ts",
    isNew: false,
    isDeleted: false,
    additions: lines.filter((line) => line.type === "add").length,
    deletions: lines.filter((line) => line.type === "remove").length,
    status: "ok",
    hunks,
    ...overrides,
  };
}

function summarize(file: ParsedDiffFile): string[] {
  return file.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.type[0]} ${line.content}`));
}

const TEN_LINES = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

describe("splitFileLines", () => {
  it("treats a trailing newline as the end of the last line", () => {
    expect(splitFileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitFileLines("a\nb")).toEqual(["a", "b"]);
    expect(splitFileLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitFileLines("")).toEqual([]);
  });
});

describe("buildFullFileDiff", () => {
  it("fills unchanged regions around hunks from the file content", () => {
    const content = TEN_LINES.map((line, index) => (index === 4 ? "line 5 changed" : line))
      .concat("line 11")
      .join("\n");
    const file = makeFile([
      {
        oldStart: 4,
        oldCount: 3,
        newStart: 4,
        newCount: 3,
        lines: [
          { type: "header", content: "@@ -4,3 +4,3 @@" },
          { type: "context", content: "line 4" },
          { type: "remove", content: "line 5" },
          { type: "add", content: "line 5 changed" },
          { type: "context", content: "line 6" },
        ],
      },
      {
        oldStart: 10,
        oldCount: 1,
        newStart: 10,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -10,1 +10,2 @@" },
          { type: "context", content: "line 10" },
          { type: "add", content: "line 11" },
        ],
      },
    ]);

    const result = buildFullFileDiff({ file, newContent: content });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(summarize(result.file)).toEqual([
      "c line 1",
      "c line 2",
      "c line 3",
      "c line 4",
      "r line 5",
      "a line 5 changed",
      "c line 6",
      "c line 7",
      "c line 8",
      "c line 9",
      "c line 10",
      "a line 11",
    ]);
    expect(result.file.hunks).toHaveLength(1);
    expect(result.file.hunks[0]).toMatchObject({
      oldStart: 1,
      oldCount: 10,
      newStart: 1,
      newCount: 11,
    });
  });

  it("places a pure deletion after the line its zero-count range names", () => {
    const file = makeFile([
      {
        oldStart: 2,
        oldCount: 1,
        newStart: 1,
        newCount: 0,
        lines: [
          { type: "header", content: "@@ -2 +1,0 @@" },
          { type: "remove", content: "gone" },
        ],
      },
    ]);

    const result = buildFullFileDiff({ file, newContent: "first\nthird\n" });

    expect(result.kind === "ready" ? summarize(result.file) : result).toEqual([
      "c first",
      "r gone",
      "c third",
    ]);
  });

  it("uses the deleted file's hunks without reading content", () => {
    const file = makeFile(
      [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 0,
          newCount: 0,
          lines: [
            { type: "header", content: "@@ -1,2 +0,0 @@" },
            { type: "remove", content: "a" },
            { type: "remove", content: "b" },
          ],
        },
      ],
      { isDeleted: true },
    );

    const result = buildFullFileDiff({ file, newContent: null });

    expect(result.kind === "ready" ? summarize(result.file) : result).toEqual(["r a", "r b"]);
  });

  it("reports out_of_sync when the file no longer matches the diff", () => {
    const file = makeFile([
      {
        oldStart: 2,
        oldCount: 1,
        newStart: 2,
        newCount: 1,
        lines: [
          { type: "remove", content: "old" },
          { type: "add", content: "new" },
        ],
      },
    ]);

    expect(buildFullFileDiff({ file, newContent: "one\nsomething else\n" })).toEqual({
      kind: "unavailable",
      reason: "out_of_sync",
    });
    expect(buildFullFileDiff({ file, newContent: "one\n" })).toEqual({
      kind: "unavailable",
      reason: "out_of_sync",
    });
  });

  it("tolerates whitespace-only differences from whitespace-insensitive diffs", () => {
    const file = makeFile([
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "context", content: "if (x) {" },
          { type: "add", content: "  call();" },
        ],
      },
    ]);

    const result = buildFullFileDiff({ file, newContent: "if (x)  {\n    call();\n}\n" });

    expect(result.kind === "ready" ? summarize(result.file) : result).toEqual([
      "c if (x)  {",
      "a     call();",
      "c }",
    ]);
  });

  it("prefers client tokens for new-side lines and keeps server tokens for removals", () => {
    const file = makeFile([
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          { type: "remove", content: "a", tokens: [{ text: "a", style: "keyword" }] },
          { type: "add", content: "b", tokens: [{ text: "b", style: "keyword" }] },
        ],
      },
    ]);

    const result = buildFullFileDiff({
      file,
      newContent: "b\nc\n",
      newTokens: [[{ text: "b", style: "string" }], [{ text: "c", style: "number" }]],
    });

    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.file.hunks[0]!.lines.map((line) => line.tokens?.[0]?.style)).toEqual([
      "keyword",
      "string",
      "number",
    ]);
  });

  it("does not expand binary or oversized files", () => {
    expect(buildFullFileDiff({ file: makeFile([], { status: "binary" }), newContent: "" })).toEqual(
      {
        kind: "unavailable",
        reason: "binary",
      },
    );
    expect(
      buildFullFileDiff({ file: makeFile([], { status: "too_large" }), newContent: "" }),
    ).toEqual({ kind: "unavailable", reason: "too_large" });
  });
});

describe("diffFileSignature", () => {
  it("changes when the hunk layout changes", () => {
    const hunk: DiffHunk = { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] };
    const base = makeFile([hunk]);
    expect(diffFileSignature(base)).toBe(diffFileSignature(makeFile([{ ...hunk }])));
    expect(diffFileSignature(base)).not.toBe(
      diffFileSignature(makeFile([{ ...hunk, newCount: 2 }])),
    );
  });
});

describe("review context from a full-file expansion", () => {
  it("attaches a comment on an unchanged line that the hunks alone would drop", () => {
    const file = makeFile([
      {
        oldStart: 9,
        oldCount: 1,
        newStart: 9,
        newCount: 1,
        lines: [
          { type: "header", content: "@@ -9 +9 @@" },
          { type: "remove", content: "line 9" },
          { type: "add", content: "line 9 changed" },
        ],
      },
    ]);
    const content = TEN_LINES.map((line, index) => (index === 8 ? "line 9 changed" : line)).join(
      "\n",
    );
    const expansion = buildFullFileDiff({ file, newContent: content });
    if (expansion.kind !== "ready") throw new Error("expected ready");
    const comment = {
      id: "comment-1",
      filePath: file.path,
      side: "new" as const,
      lineNumber: 2,
      body: "Why keep this?",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    const snapshotFor = (diffFiles: ParsedDiffFile[]) =>
      buildReviewAttachmentSnapshot({
        reviewDraftKey: "review:key",
        cwd: "/repo",
        mode: "uncommitted",
        comments: [comment],
        diffFiles,
      });

    expect(snapshotFor([file])).toBeNull();
    const attached = snapshotFor([expansion.file])?.attachment.comments[0];
    expect(attached?.context.targetLine).toEqual({
      oldLineNumber: 2,
      newLineNumber: 2,
      type: "context",
      content: "line 2",
    });
    expect(attached?.context.lines.map((line) => line.content)).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
    ]);
  });
});
