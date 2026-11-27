import { describe, expect, test } from "vitest";
import { isWithinClaim, tasksOverlap } from "./workspace-touches.js";

const t = (...touches: string[]) => ({ touches });
const none = {};

describe("tasksOverlap", () => {
  test("different files and directories do not overlap", () => {
    expect(tasksOverlap(t("src/a.ts"), t("src/b.ts"))).toBe(false);
    expect(tasksOverlap(t("src/a/"), t("src/b/"))).toBe(false);
    expect(tasksOverlap(t("src/a.ts"), t("src/ab.ts"))).toBe(false);
    expect(tasksOverlap(t("src/a"), t("src/ab/x.ts"))).toBe(false);
  });

  test("the same file, or a file inside a declared directory, overlaps", () => {
    expect(tasksOverlap(t("src/a.ts"), t("src/a.ts"))).toBe(true);
    expect(tasksOverlap(t("src/a/"), t("src/a/x.ts"))).toBe(true);
    expect(tasksOverlap(t("src/a"), t("src/a/x.ts"))).toBe(true);
    expect(tasksOverlap(t("src/"), t("src/a/"))).toBe(true);
  });

  test("a glob claims the directory above it", () => {
    expect(tasksOverlap(t("src/a/**"), t("src/a/x.ts"))).toBe(true);
    expect(tasksOverlap(t("src/a/*.ts"), t("src/b/y.ts"))).toBe(false);
  });

  test("a task that declares nothing, or leaves the checkout, claims everything", () => {
    expect(tasksOverlap(none, t("src/a.ts"))).toBe(true);
    expect(tasksOverlap(t("src/a.ts"), none)).toBe(true);
    expect(tasksOverlap(t("../other/x.ts"), t("src/a.ts"))).toBe(true);
    expect(tasksOverlap(t("/etc/hosts"), t("src/a.ts"))).toBe(true);
    expect(tasksOverlap(t("."), t("src/a.ts"))).toBe(true);
  });
});

describe("isWithinClaim", () => {
  test("only files inside what the task declared", () => {
    const task = t("src/a/", "docs/x.md");
    expect(isWithinClaim(task, "src/a/deep/file.ts")).toBe(true);
    expect(isWithinClaim(task, "docs/x.md")).toBe(true);
    expect(isWithinClaim(task, "src/b/file.ts")).toBe(false);
    expect(isWithinClaim(none, "anything/at/all.ts")).toBe(true);
  });
});
