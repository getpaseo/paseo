import { describe, expect, test } from "vitest";
import {
  buildFileSearchRows,
  createInitialFileSearchState,
  fileSearchReducer,
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
