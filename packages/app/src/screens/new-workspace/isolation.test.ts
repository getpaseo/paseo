import { describe, expect, test } from "vitest";
import {
  buildIsolationOptions,
  isolationFromOptionId,
  isolationLabel,
  isolationOptionId,
  resolveIsolation,
  selectExistingWorktrees,
  worktreeDisplayName,
} from "./isolation";

const t = ((key: string) => key) as unknown as Parameters<typeof buildIsolationOptions>[0]["t"];

describe("selectExistingWorktrees", () => {
  test("drops the main working tree, which Local already covers", () => {
    const selected = selectExistingWorktrees({
      worktrees: [
        { worktreePath: "/repo", branchName: "main", isMainWorktree: true },
        { worktreePath: "/repo-worktrees/fix", branchName: "fix" },
      ],
      sourceDirectory: null,
    });

    expect(selected).toEqual([{ path: "/repo-worktrees/fix", branchName: "fix" }]);
  });

  test("drops the project's own source directory even when git does not call it main", () => {
    const selected = selectExistingWorktrees({
      worktrees: [
        { worktreePath: "/repo", branchName: "main", isMainWorktree: true },
        { worktreePath: "/worktrees/current/", branchName: "current" },
        { worktreePath: "/worktrees/other", branchName: "other" },
      ],
      sourceDirectory: "/worktrees/current",
    });

    expect(selected.map((worktree) => worktree.path)).toEqual(["/worktrees/other"]);
  });

  test("keeps a detached worktree, which has no branch", () => {
    const selected = selectExistingWorktrees({
      worktrees: [{ worktreePath: "/worktrees/detached" }],
      sourceDirectory: null,
    });

    expect(selected).toEqual([{ path: "/worktrees/detached", branchName: null }]);
  });
});

describe("worktreeDisplayName", () => {
  test("prefers the branch", () => {
    expect(worktreeDisplayName({ path: "/worktrees/abc123", branchName: "feat/x" })).toBe("feat/x");
  });

  test("falls back to the directory name when the head is detached", () => {
    expect(worktreeDisplayName({ path: "/worktrees/abc123/", branchName: null })).toBe("abc123");
  });
});

describe("option ids", () => {
  test("round-trip a path containing the separator", () => {
    const isolation = { kind: "existing-worktree", path: "/worktrees/a:b" } as const;
    expect(isolationFromOptionId(isolationOptionId(isolation))).toEqual(isolation);
  });

  test("unknown ids resolve to local", () => {
    expect(isolationFromOptionId("nonsense")).toEqual({ kind: "local" });
  });
});

describe("buildIsolationOptions", () => {
  test("omits New worktree when the project cannot host one but still lists existing ones", () => {
    const options = buildIsolationOptions({
      t,
      canCreateWorktree: false,
      existingWorktrees: [{ path: "/worktrees/fix", branchName: "fix" }],
    });

    expect(options.map((option) => option.id)).toEqual([
      "local",
      "existing-worktree:/worktrees/fix",
    ]);
  });

  test("sections only the existing worktrees, so the header lands above the first of them", () => {
    const options = buildIsolationOptions({
      t,
      canCreateWorktree: true,
      existingWorktrees: [
        { path: "/worktrees/a", branchName: "a" },
        { path: "/worktrees/b", branchName: "b" },
      ],
    });

    expect(options.map((option) => option.section)).toEqual([
      undefined,
      undefined,
      "newWorkspace.isolation.existingSection",
      "newWorkspace.isolation.existingSection",
    ]);
    expect(options[2]?.description).toBe("/worktrees/a");
  });
});

describe("resolveIsolation", () => {
  test("keeps an existing worktree that is still listed", () => {
    const isolation = { kind: "existing-worktree", path: "/worktrees/fix" } as const;

    expect(
      resolveIsolation({
        isolation,
        canCreateWorktree: true,
        existingWorktrees: [{ path: "/worktrees/fix", branchName: "fix" }],
      }),
    ).toEqual(isolation);
  });

  test("falls back to local once the worktree is gone", () => {
    expect(
      resolveIsolation({
        isolation: { kind: "existing-worktree", path: "/worktrees/gone" },
        canCreateWorktree: true,
        existingWorktrees: [],
      }),
    ).toEqual({ kind: "local" });
  });

  test("falls back to local when the project cannot cut a worktree", () => {
    expect(
      resolveIsolation({
        isolation: { kind: "worktree" },
        canCreateWorktree: false,
        existingWorktrees: [],
      }),
    ).toEqual({ kind: "local" });
  });
});

describe("isolationLabel", () => {
  test("names the picked worktree", () => {
    expect(
      isolationLabel({
        t,
        isolation: { kind: "existing-worktree", path: "/worktrees/fix" },
        existingWorktrees: [{ path: "/worktrees/fix", branchName: "fix" }],
      }),
    ).toBe("fix");
  });
});
