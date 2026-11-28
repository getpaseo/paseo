import { describe, expect, it } from "vitest";

import {
  buildLineDiff,
  parseUnifiedDiff,
  extractTaskEntriesFromToolCall,
} from "./tool-call-parsers";

describe("tool-call-parsers", () => {
  it("builds line diff for text changes", () => {
    const diff = buildLineDiff("old\nline\n", "new\nline\n");

    expect(diff.some((entry) => entry.type === "remove")).toBe(true);
    expect(diff.some((entry) => entry.type === "add")).toBe(true);
  });

  it("keeps an edit visible in a compact preview of a 6,000-line file", () => {
    const context = "- a\n".repeat(3_000);
    const before = context + context;
    const after = `${context}- b\n${context.slice(4)}`;

    const preview = buildLineDiff(before, after);

    expect(preview).toHaveLength(10);
    expect(preview.slice(4, 6).map((line) => line.type)).toEqual(["remove", "add"]);
    expect(preview.filter((line) => line.type === "remove").map((line) => line.content)).toEqual([
      "-- a",
    ]);
    expect(preview.filter((line) => line.type === "add").map((line) => line.content)).toEqual([
      "+- b",
    ]);
  });

  it("retains edits on both sides of a long unchanged range", () => {
    const context = "- a\n".repeat(5_998);
    const preview = buildLineDiff(`- b\n${context}- d\n`, `- c\n${context}- e\n`);

    expect(preview.filter((line) => line.type === "remove").map((line) => line.content)).toEqual([
      "-- b",
      "-- d",
    ]);
    expect(preview.filter((line) => line.type === "add").map((line) => line.content)).toEqual([
      "+- c",
      "+- e",
    ]);
    expect(preview).toHaveLength(12);
  });

  it("shows a bounded replacement preview when an edit rewrites the file", () => {
    const preview = buildLineDiff("- a\n".repeat(6_000), "- b\n".repeat(6_000));

    expect(preview[0]).toEqual({ type: "remove", content: "-- a" });
    expect(preview).toContainEqual({ type: "add", content: "+- b" });
    expect(preview.at(-1)).toEqual({ type: "header", content: "…" });
    expect(preview).toHaveLength(65);
  });

  it("parses unified diff", () => {
    const parsed = parseUnifiedDiff("@@\n-old\n+new\n");

    expect(parsed.find((entry) => entry.type === "remove")?.content).toBe("-old");
    expect(parsed.find((entry) => entry.type === "add")?.content).toBe("+new");
  });

  it("keeps file headers in multi-file diffs", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/alpha.txt b/alpha.txt",
        "--- a/alpha.txt",
        "+++ b/alpha.txt",
        "@@ -1 +1 @@",
        "-color = blue",
        "+color = green",
        "diff --git a/beta.txt b/beta.txt",
        "--- a/beta.txt",
        "+++ b/beta.txt",
        "@@ -1 +1 @@",
        "-size = small",
        "+size = large",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      { type: "header", content: "diff --git a/alpha.txt b/alpha.txt" },
      { type: "header", content: "@@ -1 +1 @@" },
      { type: "remove", content: "-color = blue" },
      { type: "add", content: "+color = green" },
      { type: "header", content: "diff --git a/beta.txt b/beta.txt" },
      { type: "header", content: "@@ -1 +1 @@" },
      { type: "remove", content: "-size = small" },
      { type: "add", content: "+size = large" },
    ]);
  });

  it("extracts TodoWrite task entries", () => {
    const tasks = extractTaskEntriesFromToolCall("TodoWrite", {
      todos: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "completed" },
      ],
    });

    expect(tasks?.map((task) => task.text)).toEqual(["Task 1", "Task 2"]);
    expect(tasks?.map((task) => task.completed)).toEqual([false, true]);
  });
});
