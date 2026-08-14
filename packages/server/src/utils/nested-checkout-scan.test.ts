import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanForNestedCheckouts, invalidateNestedCheckoutScanCache } from "./nested-checkout-scan";

let tempRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-b", "main");
  writeFileSync(join(cwd, "a.txt"), "a");
  git(cwd, "add", ".");
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
    {
      stdio: "pipe",
    },
  );
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "paseo-scan-"));
  invalidateNestedCheckoutScanCache();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("scanForNestedCheckouts", () => {
  it("finds a direct-child repo and resolves its branch", async () => {
    const repoDir = join(tempRoot, "repo-a");
    initRepo(repoDir);

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({
      name: "repo-a",
      branch: "main",
      isWorktree: false,
    });
    expect(checkouts[0].path).toBe(repoDir);
  });

  it("finds checkouts inside hidden directories two levels deep", async () => {
    // The primary use case: a worktree collection like ~/SAGE/.worktrees/<name>.
    const hiddenDir = join(tempRoot, ".worktrees");
    mkdirSync(hiddenDir, { recursive: true });
    const repoDir = join(hiddenDir, "my-checkout");
    initRepo(repoDir);

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].name).toBe("my-checkout");
    expect(checkouts[0].branch).toBe("main");
  });

  it("does not descend into a detected checkout", async () => {
    const outer = join(tempRoot, "outer");
    initRepo(outer);
    // A repo nested *inside* the outer checkout must not be reported by a scan
    // of tempRoot (it belongs to a scan of outer, and descending would explode
    // the work on monorepos).
    initRepo(join(outer, "inner"));

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts.map((c) => c.name)).toEqual(["outer"]);
  });

  it("does not report repos deeper than the depth cap", async () => {
    initRepo(join(tempRoot, "l1", "l2", "l3", "deep-repo"));

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts).toHaveLength(0);
  });

  it("skips ignored directory names", async () => {
    initRepo(join(tempRoot, "node_modules", "bundled-repo"));
    initRepo(join(tempRoot, "regular-repo"));

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts.map((c) => c.name)).toEqual(["regular-repo"]);
  });

  it("marks linked worktrees and reports their branch", async () => {
    const mainDir = join(tempRoot, "main-repo");
    initRepo(mainDir);
    const worktreeDir = join(tempRoot, ".worktrees", "wt-feature");
    mkdirSync(join(tempRoot, ".worktrees"), { recursive: true });
    git(mainDir, "worktree", "add", "-b", "feature/x", worktreeDir);

    const checkouts = await scanForNestedCheckouts(tempRoot);
    const worktree = checkouts.find((c) => c.name === "wt-feature");

    expect(worktree).toBeDefined();
    expect(worktree?.isWorktree).toBe(true);
    expect(worktree?.branch).toBe("feature/x");
  });

  it("never reports the scan root itself", async () => {
    initRepo(tempRoot);
    initRepo(join(tempRoot, "child-repo"));

    const checkouts = await scanForNestedCheckouts(tempRoot);

    expect(checkouts.every((c) => c.path !== tempRoot)).toBe(true);
    expect(checkouts.map((c) => c.name)).toEqual(["child-repo"]);
  });

  it("caches results within the TTL window", async () => {
    const repoDir = join(tempRoot, "repo-cache");
    initRepo(repoDir);

    const first = await scanForNestedCheckouts(tempRoot);
    // Remove the repo; a cached second scan must still return it.
    rmSync(repoDir, { recursive: true, force: true });
    const second = await scanForNestedCheckouts(tempRoot);

    expect(second).toEqual(first);
    invalidateNestedCheckoutScanCache();
    const third = await scanForNestedCheckouts(tempRoot);
    expect(third).toHaveLength(0);
  });
});
