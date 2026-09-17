import { expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { selectChapterFiles } from "@getpaseo/protocol/chapters";
import {
  buildNumberedDiffHunks,
  buildUnifiedDiffLines,
  buildSplitDiffRows,
} from "@/utils/diff-layout";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
} from "@/workspace-tabs/identity";
import { panelSupportsHost } from "@/panels/panel-manifest";
const source: ParsedDiffFile = {
  path: "feature.ts",
  isNew: false,
  isDeleted: false,
  additions: 2,
  deletions: 2,
  hunks: [
    {
      oldStart: 10,
      oldCount: 4,
      newStart: 10,
      newCount: 4,
      lines: [
        { type: "header", content: "@@ -10,4 +10,4 @@" },
        { type: "context", content: "before" },
        { type: "remove", content: "old first" },
        { type: "add", content: "new first" },
        { type: "context", content: "between" },
        { type: "remove", content: "old second" },
        { type: "add", content: "new second" },
      ],
    },
  ],
};
it("keeps comment targets and original source identities in unified and split chapter diffs", () => {
  const original = buildNumberedDiffHunks(source)[0].lines[6];
  const [chapter] = selectChapterFiles(
    [source],
    [{ fileIndex: 0, hunkIndex: 0, startLine: 4, endLine: 7 }],
  );
  const unified = buildUnifiedDiffLines(chapter).find((line) => line.line.content === "new second");
  expect(unified?.reviewTarget).toMatchObject({
    key: original.newCell?.key,
    lineNumber: 13,
    hunkIndex: 0,
    lineIndex: 6,
  });
  const split = buildSplitDiffRows(chapter).find(
    (row) => row.kind === "pair" && row.right?.content === "new second",
  );
  expect(split).toMatchObject({
    kind: "pair",
    left: { lineNumber: 13 },
    right: { lineNumber: 13, hunkIndex: 0, lineIndex: 6 },
  });
});
it("reuses a single main chapter tab and keeps the outline in Explorer", () => {
  expect(
    buildDeterministicWorkspaceTabId({ kind: "chapter", selectionId: "first", category: false }),
  ).toBe(
    buildDeterministicWorkspaceTabId({ kind: "chapter", selectionId: "next", category: true }),
  );
  expect(
    normalizeWorkspaceTabTarget({ kind: "chapter", selectionId: "first", category: false }),
  ).toEqual({ kind: "chapter", selectionId: "first", category: false });
  expect(panelSupportsHost("chapters", "explorer")).toBe(true);
  expect(panelSupportsHost("chapters", "main")).toBe(false);
  expect(panelSupportsHost("chapter", "main")).toBe(true);
});

it("keeps display keys distinct when sections share a source hunk", () => {
  const [selected] = selectChapterFiles(
    [source],
    [
      { fileIndex: 0, hunkIndex: 0, startLine: 1, endLine: 5 },
      { fileIndex: 0, hunkIndex: 0, startLine: 4, endLine: 7 },
    ],
  );
  const rows = buildUnifiedDiffLines(selected);
  expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  const context = rows.filter((row) => row.line.content === "between");
  expect(context).toHaveLength(2);
  expect(context[0].reviewTarget?.key).toBe(context[1].reviewTarget?.key);
});
