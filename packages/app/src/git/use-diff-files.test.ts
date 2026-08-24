import { describe, expect, it } from "vitest";
import type { CheckoutCommitFile, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { resolveCommitDiffFiles } from "./use-diff-files";

function createCommitFile(
  overrides: Partial<CheckoutCommitFile> & { path: string },
): CheckoutCommitFile {
  return {
    path: overrides.path,
    additions: overrides.additions ?? 0,
    deletions: overrides.deletions ?? 0,
    ...(overrides.status ? { status: overrides.status } : {}),
  };
}

function createParsedDiffFile(
  overrides: Partial<ParsedDiffFile> & { path: string },
): ParsedDiffFile {
  return {
    path: overrides.path,
    isNew: overrides.isNew ?? false,
    isDeleted: overrides.isDeleted ?? false,
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 0,
    hunks: overrides.hunks ?? [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: "x", tokens: [] }],
      },
    ],
    status: overrides.status,
  } as ParsedDiffFile;
}

describe("resolveCommitDiffFiles", () => {
  it("keeps pending commit files out of the shared view until their per-file diff resolves", () => {
    const files = [
      createCommitFile({ path: "blob.bin", status: "added" }),
      createCommitFile({ path: "src/app.ts", additions: 3, deletions: 1, status: "modified" }),
    ];

    const resolvedByPath = new Map<string, ParsedDiffFile | null | undefined>([
      ["blob.bin", undefined],
      [
        "src/app.ts",
        createParsedDiffFile({
          path: "src/app.ts",
          additions: 3,
          deletions: 1,
        }),
      ],
    ]);

    expect(resolveCommitDiffFiles(files, resolvedByPath)).toEqual([
      expect.objectContaining({
        path: "src/app.ts",
        additions: 3,
        deletions: 1,
      }),
    ]);
  });

  it("preserves binary-only commit files from commit metadata when the per-file diff is null", () => {
    const files = [
      createCommitFile({ path: "blob.bin", status: "added" }),
      createCommitFile({ path: "src/app.ts", additions: 3, deletions: 1, status: "modified" }),
    ];

    const resolvedByPath = new Map<string, ParsedDiffFile | null>([
      ["blob.bin", null],
      [
        "src/app.ts",
        createParsedDiffFile({
          path: "src/app.ts",
          additions: 3,
          deletions: 1,
        }),
      ],
    ]);

    expect(resolveCommitDiffFiles(files, resolvedByPath)).toEqual([
      {
        path: "blob.bin",
        isNew: true,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        status: "binary",
      },
      expect.objectContaining({
        path: "src/app.ts",
        additions: 3,
        deletions: 1,
      }),
    ]);
  });
});
