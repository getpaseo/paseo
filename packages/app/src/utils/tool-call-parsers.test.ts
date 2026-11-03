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
