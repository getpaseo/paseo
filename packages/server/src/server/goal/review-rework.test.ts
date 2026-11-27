import { describe, expect, test } from "vitest";
import type { ChangeSet } from "@getpaseo/protocol/goal/types";
import { describeRework } from "./review.js";

function changeSet(id: string, taskId: string, status: ChangeSet["status"], paths: string[]) {
  return {
    id,
    taskId,
    runId: `${id}-run`,
    round: 0,
    supersedes: null,
    workspaceId: "w",
    cwd: "/w",
    branch: `b-${id}`,
    baseCommit: "base",
    headCommit: "head",
    files: paths.map((path) => ({ path, status: "M" })),
    status,
    findings: null,
    testSummary: "2 failed",
    integratedCommit: null,
    error: "conflict in a.ts",
  } satisfies ChangeSet;
}

describe("describeRework", () => {
  const mine = changeSet("cs-b", "t2", "test_failed", ["src/b.ts"]);
  const earlier = changeSet("cs-a", "t1", "integrated", ["src/a.ts", "src/shared.ts"]);

  test("names the changes merged after the base for test failures and conflicts", () => {
    for (const reason of ["tests", "conflict"] as const) {
      const text = describeRework(mine, reason, [earlier]);
      expect(text).toContain("cs-a (task t1): src/a.ts, src/shared.ts");
      expect(text).toContain("reviewed against the older base");
    }
  });

  test("a review request does not list merged changes", () => {
    expect(describeRework(mine, "review", [earlier])).not.toContain("cs-a");
  });

  test("leaves the description alone when nothing was merged", () => {
    expect(describeRework(mine, "tests", [])).not.toContain("older base");
  });

  test("caps the list and counts the omitted changes and files", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      changeSet(`cs-${i}`, `m${i}`, "integrated", ["a", "b", "c", "d", "e", "f", "g", "h"]),
    );
    const text = describeRework(mine, "tests", many);
    expect(text).toContain("(2 earlier ones not listed)");
    expect(text).toContain("cs-9 (task m9): a, b, c, d, e, f, and 2 more");
    expect(text).not.toContain("cs-1 (task");
  });
});
