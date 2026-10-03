import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { DiffFindModel, type FindScheduler } from "./model";

function file(
  lines: ParsedDiffFile["hunks"][number]["lines"],
  path = "src/example.ts",
): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 1,
    hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines }],
  };
}

function clock() {
  const tasks = new Set<() => void>();
  const scheduler: FindScheduler = {
    schedule(run) {
      tasks.add(run);
      return () => {
        tasks.delete(run);
      };
    },
    now: () => 0,
  };
  return {
    scheduler,
    pending: () => tasks.size,
    step() {
      const run = tasks.values().next().value;
      if (run) {
        tasks.delete(run);
        run();
      }
    },
    flush() {
      while (tasks.size) {
        const batch = [...tasks];
        tasks.clear();
        for (const run of batch) run();
      }
    },
  };
}

describe("diff Find", () => {
  it("searches canonical added, removed and context text, not hunk headers", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    const source = file([
      { type: "header", content: "needle" },
      { type: "remove", content: "old NEEDLE" },
      { type: "add", content: "new needle needle" },
      { type: "context", content: "needle" },
    ]);
    model.setFiles([source]);
    model.open();
    model.setQuery("needle");
    time.flush();
    expect(
      model.getSnapshot().matches.map(({ lineIndex, start, end }) => ({ lineIndex, start, end })),
    ).toEqual([
      { lineIndex: 1, start: 4, end: 10 },
      { lineIndex: 2, start: 4, end: 10 },
      { lineIndex: 2, start: 11, end: 17 },
      { lineIndex: 3, start: 0, end: 6 },
    ]);
    expect(model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot().current).toBe(0);
    model.previous();
    expect(model.getSnapshot().current).toBe(3);
    model.next();
    expect(model.getSnapshot().current).toBe(0);
  });

  it("does no search work while closed and releases pending work on close", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([file([{ type: "add", content: "a".repeat(100_000) }])]);
    model.setQuery("a");
    expect(time.pending()).toBe(0);
    model.open();
    time.step();
    expect(model.getSnapshot().phase).toBe("searching");
    model.close();
    expect(time.pending()).toBe(0);
    time.flush();
    expect(model.getSnapshot().phase).toBe("closed");
    expect(model.getSnapshot().matches).toEqual([]);
    expect(model.getSnapshot().byLine.size).toBe(0);
  });

  it("cancels an old query and a replaced diff snapshot", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([file([{ type: "add", content: "a".repeat(100_000) }])]);
    model.open();
    model.setQuery("a");
    time.step();
    model.setQuery("b");
    const next = file([{ type: "remove", content: "b" }]);
    model.setFiles([next]);
    time.flush();
    expect(model.getSnapshot().matches).toEqual([
      { file: next, hunkIndex: 0, lineIndex: 0, start: 0, end: 1 },
    ]);
  });

  it("uses original UTF-16 offsets for Unicode and treats regex syntax literally", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    const source = file([{ type: "add", content: "İ 😀 中文 é A+B AAB" }]);
    model.setFiles([source]);
    model.open();
    for (const query of ["😀", "中文", "é", "a+b"]) {
      model.setQuery(query);
      time.flush();
      const matches = model.getSnapshot().matches;
      expect(matches.length).toBe(1);
      const match = matches[0];
      expect(source.hunks[0].lines[0].content.slice(match.start, match.end).toLowerCase()).toBe(
        query,
      );
    }
  });

  it("finds a literal crossing a long-line scan boundary exactly once", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([
      file([{ type: "add", content: `${"x".repeat(32_766)}needle${"x".repeat(40_000)}needle` }]),
    ]);
    model.open();
    model.setQuery("needle");
    time.flush();
    expect(model.getSnapshot().matches.map((match) => match.start)).toEqual([32_766, 72_772]);
  });

  it("reports a capped count without allocating every occurrence", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([file([{ type: "add", content: "a ".repeat(20_000) }])]);
    model.open();
    model.setQuery("a");
    time.flush();
    expect(model.getSnapshot().matches.length).toBe(10_000);
    expect(model.getSnapshot().limited).toBe(true);
  });

  it("does not label an exact-limit result as truncated", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([file([{ type: "add", content: "a ".repeat(10_000) }])]);
    model.open();
    model.setQuery("a");
    time.flush();
    expect(model.getSnapshot().matches.length).toBe(10_000);
    expect(model.getSnapshot().limited).toBe(false);
  });

  it("reports excluded binary and oversized files", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    const binary = { ...file([], "image.png"), status: "binary" as const };
    const large = { ...file([], "large.txt"), status: "too_large" as const };
    model.setFiles([binary, large]);
    model.open();
    model.setQuery("needle");
    time.flush();
    expect(model.getSnapshot().matches).toEqual([]);
    expect(model.getSnapshot().skippedFiles).toBe(2);
  });

  it("reuses unchanged file results while invalidating changed files", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    const first = file([{ type: "add", content: "needle" }], "a.ts");
    const second = file([{ type: "add", content: "needle" }], "b.ts");
    model.setFiles([first, second]);
    model.open();
    model.setQuery("needle");
    time.flush();
    model.next();
    const original = model.getSnapshot().matches[1];
    model.setFiles([file([{ type: "add", content: "new content" }], "a.ts"), second]);
    time.flush();
    expect(model.getSnapshot().matches).toEqual([original]);
    expect(model.getSnapshot().matches[0]).toBe(original);
    expect(model.getSnapshot().current).toBe(0);
  });

  it("rejects multiline queries and clears a query without scanning", () => {
    const time = clock();
    const model = new DiffFindModel(time.scheduler);
    model.setFiles([
      file([
        { type: "add", content: "one" },
        { type: "add", content: "two" },
      ]),
    ]);
    model.open();
    model.setQuery("one\ntwo");
    expect(time.pending()).toBe(0);
    expect(model.getSnapshot().matches).toEqual([]);
    model.setQuery("");
    expect(model.getSnapshot().current).toBe(-1);
    expect(model.getSnapshot().phase).toBe("ready");
  });
});
