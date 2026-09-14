import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { retainDiffFiles, shareCheckoutDiff, shareCommitFileDiff } from "./diff-sharing";

const file: ParsedDiffFile = {
  path: "a.ts",
  oldPath: "old-a.ts",
  status: "ok",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        {
          type: "add",
          content: "const a",
          tokens: [
            { text: "const", style: "keyword" },
            { text: " a", style: null },
          ],
        },
      ],
    },
  ],
};

// Exhaustive keys make a protocol-field addition require a sharing-policy test.
const fileChanges = {
  path: (value) => {
    value.path = "b.ts";
  },
  oldPath: (value) => {
    delete value.oldPath;
  },
  status: (value) => {
    value.status = "binary";
  },
  isNew: (value) => {
    value.isNew = true;
  },
  isDeleted: (value) => {
    value.isDeleted = true;
  },
  additions: (value) => {
    value.additions = 2;
  },
  deletions: (value) => {
    value.deletions = 2;
  },
  hunks: (value) => {
    value.hunks = [];
  },
} satisfies Record<keyof ParsedDiffFile, (value: ParsedDiffFile) => void>;
type Hunk = ParsedDiffFile["hunks"][number];
const hunkChanges = {
  oldStart: (value) => {
    value.oldStart = 2;
  },
  oldCount: (value) => {
    value.oldCount = 2;
  },
  newStart: (value) => {
    value.newStart = 2;
  },
  newCount: (value) => {
    value.newCount = 2;
  },
  lines: (value) => {
    value.lines = [];
  },
} satisfies Record<keyof Hunk, (value: Hunk) => void>;
type Line = Hunk["lines"][number];
const lineChanges = {
  type: (value) => {
    value.type = "remove";
  },
  content: (value) => {
    value.content = "const b";
  },
  tokens: (value) => {
    delete value.tokens;
  },
} satisfies Record<keyof Line, (value: Line) => void>;
type Token = NonNullable<Line["tokens"]>[number];
const tokenChanges = {
  text: (value) => {
    value.text = "class";
  },
  style: (value) => {
    value.style = null;
  },
} satisfies Record<keyof Token, (value: Token) => void>;

describe("diff sharing", () => {
  it.each(Object.entries(fileChanges))("replaces a file when %s changes", (_, change) => {
    const next = structuredClone(file);
    change(next);
    expect(retainDiffFiles([file], [next])[0]).toBe(next);
  });
  it.each(Object.entries(hunkChanges))("replaces a file when hunk %s changes", (_, change) => {
    const next = structuredClone(file);
    change(next.hunks[0]!);
    expect(retainDiffFiles([file], [next])[0]).toBe(next);
  });
  it.each(Object.entries(lineChanges))("replaces a file when line %s changes", (_, change) => {
    const next = structuredClone(file);
    change(next.hunks[0]!.lines[0]!);
    expect(retainDiffFiles([file], [next])[0]).toBe(next);
  });
  it.each(Object.entries(tokenChanges))("replaces a file when token %s changes", (_, change) => {
    const next = structuredClone(file);
    change(next.hunks[0]!.lines[0]!.tokens![0]!);
    expect(retainDiffFiles([file], [next])[0]).toBe(next);
  });
  it("retains moved files and removes missing files", () => {
    const second = { ...file, path: "b.ts" };
    const reordered = retainDiffFiles([file, second], structuredClone([second, file]));
    expect(reordered[0]).toBe(second);
    expect(reordered[1]).toBe(file);
    expect(retainDiffFiles(reordered, [structuredClone(file)])[0]).toBe(file);
  });
  it("updates response metadata without invalidating unchanged text", () => {
    const previous = { cwd: "/repo", files: [file], error: null, requestId: "a" };
    expect(shareCheckoutDiff(previous, structuredClone(previous))).toBe(previous);
    const next = shareCheckoutDiff(previous, { ...structuredClone(previous), requestId: "b" });
    expect(next.requestId).toBe("b");
    expect(next.files).toBe(previous.files);
    const rejected = {
      ...previous,
      files: [],
      error: { code: "UNKNOWN", message: "Too large" },
      diffTooLarge: true,
    };
    expect(shareCheckoutDiff(next, rejected)).toEqual(rejected);
  });
  it("preserves cached commit bodies and publishes null transitions", () => {
    const previous = { file };
    expect(shareCommitFileDiff(previous, structuredClone(previous))).toBe(previous);
    expect(shareCommitFileDiff(previous, { file: null })).toEqual({ file: null });
    expect(shareCommitFileDiff({ file: null }, previous)).toBe(previous);
  });
});
