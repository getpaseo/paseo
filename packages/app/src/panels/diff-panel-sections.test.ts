import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import {
  buildDiffPanelSections,
  diffPanelBodyHeightKey,
  diffPanelItemKey,
} from "./diff-panel-sections";

function makeFile(overrides: Partial<ParsedDiffFile> & { path: string }): ParsedDiffFile {
  return {
    path: overrides.path,
    isNew: overrides.isNew ?? false,
    isDeleted: overrides.isDeleted ?? false,
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 0,
    status: overrides.status,
    hunks: overrides.hunks ?? [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: "x", tokens: [] }],
      },
    ],
  } as unknown as ParsedDiffFile;
}

describe("buildDiffPanelSections", () => {
  it("emits a header for every file and a body only for the expanded ones, in order", () => {
    const files = [makeFile({ path: "a.ts" }), makeFile({ path: "src/b.ts" })];
    const sections = buildDiffPanelSections(files, new Set(["src/b.ts"]));

    expect(sections.map((s) => [s.type, s.file.path, s.fileIndex])).toEqual([
      ["header", "a.ts", 0],
      ["header", "src/b.ts", 1],
      ["body", "src/b.ts", 1],
    ]);
  });

  it("emits header-only items for every file when nothing is expanded (default collapsed)", () => {
    const files = [makeFile({ path: "a.ts" }), makeFile({ path: "src/b.ts" })];
    const sections = buildDiffPanelSections(files, new Set());

    expect(sections.map((s) => [s.type, s.file.path, s.fileIndex])).toEqual([
      ["header", "a.ts", 0],
      ["header", "src/b.ts", 1],
    ]);
  });

  it("interleaves header+body for every file when all are expanded, in order", () => {
    const files = [makeFile({ path: "a.ts" }), makeFile({ path: "src/b.ts" })];
    const sections = buildDiffPanelSections(files, new Set(["a.ts", "src/b.ts"]));

    expect(sections.map((s) => [s.type, s.file.path, s.fileIndex])).toEqual([
      ["header", "a.ts", 0],
      ["body", "a.ts", 0],
      ["header", "src/b.ts", 1],
      ["body", "src/b.ts", 1],
    ]);
  });

  it("returns an empty list when there are no files", () => {
    expect(buildDiffPanelSections([], new Set())).toEqual([]);
  });
});

describe("diffPanelItemKey", () => {
  it("derives distinct, stable keys for the header and body of a file", () => {
    const file = makeFile({ path: "src/app.ts" });
    expect(diffPanelItemKey({ type: "header", file, fileIndex: 0 })).toBe("header-src/app.ts");
    expect(diffPanelItemKey({ type: "body", file, fileIndex: 0 })).toBe("body-src/app.ts");
  });
});

describe("diffPanelBodyHeightKey", () => {
  const opts = { layout: "unified" as const, wrapLines: false, typographyKey: "mono:12:18" };

  it("changes when the diff content changes so a stale measured height is not reused", () => {
    const small = makeFile({ path: "a.ts", additions: 1 });
    const large = makeFile({
      path: "a.ts",
      additions: 50,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 3,
          lines: [
            { type: "add", content: "one", tokens: [] },
            { type: "add", content: "two", tokens: [] },
            { type: "add", content: "three", tokens: [] },
          ],
        },
      ],
    } as unknown as ParsedDiffFile);

    expect(diffPanelBodyHeightKey(small, opts)).not.toBe(diffPanelBodyHeightKey(large, opts));
  });

  it("changes with layout/wrap/typography so cache keys are layout-specific", () => {
    const file = makeFile({ path: "a.ts" });
    expect(diffPanelBodyHeightKey(file, opts)).not.toBe(
      diffPanelBodyHeightKey(file, { ...opts, layout: "split" }),
    );
    expect(diffPanelBodyHeightKey(file, opts)).not.toBe(
      diffPanelBodyHeightKey(file, { ...opts, wrapLines: true }),
    );
    expect(diffPanelBodyHeightKey(file, opts)).not.toBe(
      diffPanelBodyHeightKey(file, { ...opts, typographyKey: "mono:14:21" }),
    );
  });

  it("keys binary/too_large bodies on status alone (content-independent height)", () => {
    const binary = makeFile({ path: "a.bin", status: "binary", additions: 0 });
    const binaryWithStats = makeFile({ path: "a.bin", status: "binary", additions: 99 });
    expect(diffPanelBodyHeightKey(binary, opts)).toBe(
      diffPanelBodyHeightKey(binaryWithStats, opts),
    );
    expect(diffPanelBodyHeightKey(binary, opts)).toContain(":binary");
  });
});
