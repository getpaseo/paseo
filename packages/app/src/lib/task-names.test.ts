import { describe, expect, test } from "vitest";
import {
  normalizeTaskName,
  ensureUniqueTaskName,
  generateFriendlyTaskName,
  MAX_TASK_NAME_LENGTH,
} from "./task-names";

describe("normalizeTaskName", () => {
  test("lowercases and trims", () => {
    expect(normalizeTaskName("  My Task  ")).toBe("my-task");
  });

  test("replaces spaces with hyphens", () => {
    expect(normalizeTaskName("fix login bug")).toBe("fix-login-bug");
  });

  test("removes special characters", () => {
    expect(normalizeTaskName("task@#$%name!")).toBe("taskname");
  });

  test("collapses multiple hyphens", () => {
    expect(normalizeTaskName("task---name")).toBe("task-name");
  });

  test("strips leading/trailing hyphens", () => {
    expect(normalizeTaskName("-task-name-")).toBe("task-name");
  });

  test("truncates to MAX_TASK_NAME_LENGTH", () => {
    const longName = "a".repeat(100);
    expect(normalizeTaskName(longName).length).toBeLessThanOrEqual(MAX_TASK_NAME_LENGTH);
  });

  test("empty string returns empty", () => {
    expect(normalizeTaskName("")).toBe("");
  });
});

describe("ensureUniqueTaskName", () => {
  test("returns base name when no conflict", () => {
    expect(ensureUniqueTaskName("my-task", [])).toBe("my-task");
  });

  test("appends number when name exists", () => {
    expect(ensureUniqueTaskName("my-task", ["my-task"])).toBe("my-task-2");
  });

  test("increments number until unique", () => {
    const existing = ["my-task", "my-task-2", "my-task-3"];
    expect(ensureUniqueTaskName("my-task", existing)).toBe("my-task-4");
  });

  test("handles Set as existing names", () => {
    const existing = new Set(["task-1", "task-2"]);
    expect(ensureUniqueTaskName("task-1", existing)).toBe("task-1-2");
  });
});

describe("generateFriendlyTaskName", () => {
  test("generates a name in adjective-noun format", () => {
    const name = generateFriendlyTaskName([], { seed: 42 });
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test("avoids existing names", () => {
    const existing: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = generateFriendlyTaskName(existing, { seed: i * 100 });
      expect(existing).not.toContain(name);
      existing.push(name);
    }
  });

  test("generates different names with different seeds", () => {
    const name1 = generateFriendlyTaskName([], { seed: 1 });
    const name2 = generateFriendlyTaskName([], { seed: 999 });
    // Different seeds should usually produce different names
    // (not guaranteed but highly likely with these seeds)
    expect(name1).not.toBe(name2);
  });

  test("falls back when all candidates are taken", () => {
    // Even with tons of existing names, should still return something
    const existing = Array.from({ length: 100 }, (_, i) => `task-${i}`);
    const name = generateFriendlyTaskName(existing, { seed: 1 });
    expect(name).toBeTruthy();
  });
});
