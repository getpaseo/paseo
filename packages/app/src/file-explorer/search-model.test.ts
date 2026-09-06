import { describe, expect, test } from "vitest";
import {
  areAllFileSearchGroupsCollapsed,
  buildFileSearchRows,
  createInitialFileSearchState,
  fileSearchReducer,
  filterCollapsedFileSearchRows,
  splitFileSearchMatchContent,
  toggleAllFileSearchGroups,
} from "./search-model";

describe("file search model", () => {
  test("keeps stale search completions from replacing the current request", () => {
    const loading = fileSearchReducer(createInitialFileSearchState(), {
      type: "start",
      requestKey: 2,
    });
    const stale = fileSearchReducer(loading, {
      type: "success",
      requestKey: 1,
      result: {
        cwd: "/workspace",
        files: [],
        totalMatches: 0,
        truncated: false,
        requestId: "stale",
      },
    });

    expect(stale).toEqual(loading);
  });

  test("builds stable file and match rows from grouped daemon results", () => {
    const rows = buildFileSearchRows({
      cwd: "/workspace",
      files: [
        {
          path: "src/search.ts",
          matches: [
            { line: 4, column: 3, matchLength: 6, lineContent: "  needle();" },
            { line: 9, column: 1, matchLength: 6, lineContent: "needle();" },
          ],
        },
      ],
      totalMatches: 2,
      truncated: false,
      requestId: "search-1",
    });

    expect(rows).toEqual([
      {
        kind: "file",
        key: "file:src/search.ts",
        path: "src/search.ts",
        matchCount: 2,
      },
      {
        kind: "match",
        key: "match:src/search.ts:4:3:0",
        path: "src/search.ts",
        match: { line: 4, column: 3, matchLength: 6, lineContent: "  needle();" },
      },
      {
        kind: "match",
        key: "match:src/search.ts:9:1:1",
        path: "src/search.ts",
        match: { line: 9, column: 1, matchLength: 6, lineContent: "needle();" },
      },
    ]);
  });

  test("keeps file headers visible while hiding matches for collapsed groups", () => {
    const rows = buildFileSearchRows({
      cwd: "/workspace",
      files: [
        {
          path: "src/first.ts",
          matches: [{ line: 1, column: 1, matchLength: 3, lineContent: "one" }],
        },
        {
          path: "src/second.ts",
          matches: [{ line: 2, column: 1, matchLength: 3, lineContent: "two" }],
        },
      ],
      totalMatches: 2,
      truncated: false,
      requestId: "search-collapse",
    });

    expect(filterCollapsedFileSearchRows(rows, new Set(["src/first.ts"]))).toEqual([
      { kind: "file", key: "file:src/first.ts", path: "src/first.ts", matchCount: 1 },
      { kind: "file", key: "file:src/second.ts", path: "src/second.ts", matchCount: 1 },
      {
        kind: "match",
        key: "match:src/second.ts:2:1:0",
        path: "src/second.ts",
        match: { line: 2, column: 1, matchLength: 3, lineContent: "two" },
      },
    ]);
  });

  test("collapses all groups, then expands all groups", () => {
    const filePaths = ["src/first.ts", "src/second.ts"];
    const collapsed = toggleAllFileSearchGroups(filePaths, new Set());
    expect([...collapsed]).toEqual(filePaths);
    expect(areAllFileSearchGroupsCollapsed(filePaths, collapsed)).toBe(true);

    const expanded = toggleAllFileSearchGroups(filePaths, collapsed);
    expect([...expanded]).toEqual([]);
    expect(areAllFileSearchGroupsCollapsed(filePaths, expanded)).toBe(false);
  });

  test("splits ordinary and windowed snippets at the exact match", () => {
    expect(
      splitFileSearchMatchContent({
        line: 1,
        column: 7,
        matchLength: 6,
        lineContent: "const needle = true;",
      }),
    ).toEqual({ prefix: "const ", match: "needle", suffix: " = true;" });

    expect(
      splitFileSearchMatchContent({
        line: 1,
        column: 701,
        matchLength: 6,
        lineContent: "xxxxneedlezzzz",
        lineContentStartColumn: 697,
      }),
    ).toEqual({ prefix: "xxxx", match: "needle", suffix: "zzzz" });
  });

  test("clamps a match that extends beyond bounded line content", () => {
    expect(
      splitFileSearchMatchContent({
        line: 1,
        column: 4,
        matchLength: 20,
        lineContent: "abcneedle",
      }),
    ).toEqual({ prefix: "abc", match: "needle", suffix: "" });
  });

  test("resets results when the query is cleared", () => {
    const state = fileSearchReducer(
      {
        status: "success",
        requestKey: 3,
        result: {
          cwd: "/workspace",
          files: [],
          totalMatches: 0,
          truncated: false,
          requestId: "search-3",
        },
      },
      { type: "reset" },
    );

    expect(state).toEqual({ status: "idle", requestKey: 0 });
  });
});
