import { describe, expect, it } from "vitest";

import { isPaseoWorktreePath, resolvePaseoWorktreePlacement } from "@/utils/paseo-worktree-path";

const DEFAULT_ROOT = "/Users/me/.paseo/worktrees";
const CUSTOM_ROOT = "/mnt/scratch/paseo-trees";

describe("resolvePaseoWorktreePlacement with a daemon-reported root", () => {
  it("recognizes a worktree under the default root", () => {
    expect(
      resolvePaseoWorktreePlacement(`${DEFAULT_ROOT}/a1b2c3d4/brave-otter`, DEFAULT_ROOT),
    ).toEqual({
      worktreePath: `${DEFAULT_ROOT}/a1b2c3d4/brave-otter`,
      projectWorktreesRoot: `${DEFAULT_ROOT}/a1b2c3d4`,
      mainRepoRoot: null,
    });
  });

  it("recognizes a worktree under a custom worktrees.root", () => {
    expect(
      resolvePaseoWorktreePlacement(`${CUSTOM_ROOT}/a1b2c3d4/brave-otter`, CUSTOM_ROOT),
    ).toEqual({
      worktreePath: `${CUSTOM_ROOT}/a1b2c3d4/brave-otter`,
      projectWorktreesRoot: `${CUSTOM_ROOT}/a1b2c3d4`,
      mainRepoRoot: null,
    });
  });

  it("keeps the worktree root when the cwd is nested inside the worktree", () => {
    expect(
      resolvePaseoWorktreePlacement(
        `${CUSTOM_ROOT}/a1b2c3d4/brave-otter/packages/app`,
        CUSTOM_ROOT,
      ),
    ).toEqual({
      worktreePath: `${CUSTOM_ROOT}/a1b2c3d4/brave-otter`,
      projectWorktreesRoot: `${CUSTOM_ROOT}/a1b2c3d4`,
      mainRepoRoot: null,
    });
  });

  it("tolerates a trailing separator on the reported root", () => {
    expect(isPaseoWorktreePath(`${CUSTOM_ROOT}/a1b2c3d4/brave-otter`, `${CUSTOM_ROOT}/`)).toBe(
      true,
    );
  });

  it("ignores the legacy path convention once a root is known", () => {
    expect(
      resolvePaseoWorktreePlacement("/Users/me/repo/.paseo/worktrees/feature", CUSTOM_ROOT),
    ).toBeNull();
  });

  it("rejects ordinary checkouts, the base root, and the per-project container", () => {
    expect(resolvePaseoWorktreePlacement("/Users/me/repo", CUSTOM_ROOT)).toBeNull();
    expect(resolvePaseoWorktreePlacement(CUSTOM_ROOT, CUSTOM_ROOT)).toBeNull();
    expect(resolvePaseoWorktreePlacement(`${CUSTOM_ROOT}/a1b2c3d4`, CUSTOM_ROOT)).toBeNull();
  });

  it("does not match a sibling directory that shares the root's prefix", () => {
    expect(
      resolvePaseoWorktreePlacement(`${CUSTOM_ROOT}-backup/a1b2c3d4/slug`, CUSTOM_ROOT),
    ).toBeNull();
  });

  it("handles windows paths without rewriting their separators", () => {
    const windowsRoot = "C:\\Users\\me\\.paseo\\worktrees";
    expect(
      resolvePaseoWorktreePlacement(`${windowsRoot}\\a1b2c3d4\\brave-otter\\src`, windowsRoot),
    ).toEqual({
      worktreePath: `${windowsRoot}\\a1b2c3d4\\brave-otter`,
      projectWorktreesRoot: `${windowsRoot}\\a1b2c3d4`,
      mainRepoRoot: null,
    });
  });

  it("matches Windows paths without regard to drive or directory casing", () => {
    expect(
      resolvePaseoWorktreePlacement(
        "c:\\users\\ME\\.PASEO\\WORKTREES\\a1b2c3d4\\brave-otter",
        "C:\\Users\\me\\.paseo\\worktrees",
      ),
    ).toMatchObject({
      worktreePath: "c:\\users\\ME\\.PASEO\\WORKTREES\\a1b2c3d4\\brave-otter",
    });
  });

  it("matches UNC paths without regard to server, share, or directory casing", () => {
    expect(
      resolvePaseoWorktreePlacement(
        "\\\\SERVER\\SHARE\\PASEO\\TREES\\a1b2c3d4\\brave-otter\\src",
        "//server/share/paseo/trees",
      ),
    ).toEqual({
      worktreePath: "\\\\SERVER\\SHARE\\PASEO\\TREES\\a1b2c3d4\\brave-otter",
      projectWorktreesRoot: "\\\\SERVER\\SHARE\\PASEO\\TREES\\a1b2c3d4",
      mainRepoRoot: null,
    });
  });

  it("keeps POSIX path comparison case-sensitive", () => {
    expect(
      resolvePaseoWorktreePlacement(
        "/mnt/Scratch/paseo-trees/a1b2c3d4/brave-otter",
        "/mnt/scratch/paseo-trees",
      ),
    ).toBeNull();
  });
});

// COMPAT(worktreesRoot): delete this block together with the fallback it covers.
describe("resolvePaseoWorktreePlacement without a daemon-reported root", () => {
  it("falls back to the legacy path convention and recovers the repo", () => {
    expect(resolvePaseoWorktreePlacement("/Users/me/repo/.paseo/worktrees/feature", null)).toEqual({
      worktreePath: "/Users/me/repo/.paseo/worktrees/feature",
      projectWorktreesRoot: "/Users/me/repo/.paseo/worktrees",
      mainRepoRoot: "/Users/me/repo",
    });
  });

  it("preserves windows separators in the recovered repo path", () => {
    expect(
      resolvePaseoWorktreePlacement("C:\\Users\\me\\repo\\.paseo\\worktrees\\feature", undefined)
        ?.mainRepoRoot,
    ).toBe("C:\\Users\\me\\repo");
  });

  it("still matches the bare marker directory", () => {
    expect(isPaseoWorktreePath("/Users/me/repo/.paseo/worktrees", null)).toBe(true);
  });

  it("requires the marker to start a path segment", () => {
    expect(isPaseoWorktreePath("/Users/me/repo/not.paseo/worktrees/feature", null)).toBe(false);
    expect(isPaseoWorktreePath("/Users/me/repo/.paseo/worktrees-old/feature", null)).toBe(false);
  });

  it("rejects ordinary checkouts and blank input", () => {
    expect(resolvePaseoWorktreePlacement("/Users/me/repo", null)).toBeNull();
    expect(resolvePaseoWorktreePlacement("   ", null)).toBeNull();
  });
});
