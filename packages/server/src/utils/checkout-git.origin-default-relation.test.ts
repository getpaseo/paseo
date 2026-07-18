import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getCheckoutStatus,
  getOriginDefaultRelation,
  resolveOriginDefaultRef,
} from "./checkout-git.js";

function initRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "paseo-odr-"));
  const repoDir = join(tempDir, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir]);
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "root\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return { tempDir, repoDir };
}

function commitFile(cwd: string, path: string, content: string, message: string): void {
  writeFileSync(join(cwd, path), content);
  execFileSync("git", ["add", path], { cwd });
  execFileSync("git", ["commit", "-m", message], { cwd });
}

function setupOrigin(repoDir: string, tempDir: string): string {
  const remoteDir = join(tempDir, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
    cwd: repoDir,
  });
  return remoteDir;
}

describe("originDefaultRelation", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    const setup = initRepo();
    tempDir = setup.tempDir;
    repoDir = setup.repoDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports exact when HEAD equals origin default tip", async () => {
    setupOrigin(repoDir, tempDir);

    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation).toEqual({
      state: "exact",
      resolvedRef: "origin/main",
      ahead: 0,
      behind: 0,
      uniquePatchCount: 0,
    });

    const status = await getCheckoutStatus(repoDir);
    expect(status.isGit).toBe(true);
    if (status.isGit) {
      expect(status.originDefaultRelation).toEqual(relation);
      // Compatibility fields remain populated.
      expect(status.aheadOfOrigin).toBe(0);
      expect(status.behindOfOrigin).toBe(0);
    }
  });

  it("reports included when HEAD is a strict ancestor of origin default", async () => {
    setupOrigin(repoDir, tempDir);
    const cloneDir = join(tempDir, "clone");
    execFileSync("git", ["clone", join(tempDir, "remote.git"), cloneDir]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    commitFile(cloneDir, "on-main.txt", "main advance\n", "advance main");
    execFileSync("git", ["push", "origin", "main"], { cwd: cloneDir });
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });
    // Stay on the pre-fetch commit (ancestor of origin/main).
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir });

    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation.state).toBe("included");
    expect(relation.resolvedRef).toBe("origin/main");
    expect(relation.ahead).toBe(0);
    expect(relation.behind).toBeGreaterThan(0);
    expect(relation.uniquePatchCount).toBe(0);
  });

  it("reports ahead when origin default is an ancestor of HEAD with unique commits", async () => {
    setupOrigin(repoDir, tempDir);
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "feature.txt", "feature\n", "feature work");

    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation).toEqual({
      state: "ahead",
      resolvedRef: "origin/main",
      ahead: 1,
      behind: 0,
      uniquePatchCount: 1,
    });
  });

  it("reports patch_equivalent_not_included when tips share a tree but not ancestry", async () => {
    setupOrigin(repoDir, tempDir);
    // Feature branch with unique commits.
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "landed.txt", "landed content\n", "feature landed");
    const featureTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoDir })
      .toString()
      .trim();

    // Squash the same tree onto main via a different commit (not ancestral of feature).
    execFileSync("git", ["checkout", "main"], { cwd: repoDir });
    commitFile(repoDir, "landed.txt", "landed content\n", "squash land");
    const mainTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoDir })
      .toString()
      .trim();
    expect(mainTree).toBe(featureTree);
    execFileSync("git", ["push", "origin", "main"], { cwd: repoDir });

    // Feature tip is not an ancestor of origin/main and not a descendant either,
    // but trees match → patch-equivalent, not inclusion.
    execFileSync("git", ["checkout", "feature"], { cwd: repoDir });
    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation.state).toBe("patch_equivalent_not_included");
    expect(relation.resolvedRef).toBe("origin/main");
    expect(relation.ahead).toBeGreaterThan(0);
    expect(relation.behind).toBeGreaterThan(0);
    expect(relation.uniquePatchCount).toBe(0);
  });

  it("reports diverged_with_unique_commits when histories diverge with unique patches", async () => {
    setupOrigin(repoDir, tempDir);
    const cloneDir = join(tempDir, "clone");
    execFileSync("git", ["clone", join(tempDir, "remote.git"), cloneDir]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
    commitFile(cloneDir, "main-only.txt", "main\n", "main only");
    execFileSync("git", ["push", "origin", "main"], { cwd: cloneDir });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
    commitFile(repoDir, "feature-only.txt", "feature\n", "feature only");
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation.state).toBe("diverged_with_unique_commits");
    expect(relation.resolvedRef).toBe("origin/main");
    expect(relation.ahead).toBeGreaterThan(0);
    expect(relation.behind).toBeGreaterThan(0);
    expect(relation.uniquePatchCount).toBeGreaterThan(0);
  });

  it("reports unverifiable when origin default cannot be resolved", async () => {
    // No remote configured — no refs/remotes/origin/HEAD.
    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation).toEqual({
      state: "unverifiable",
      resolvedRef: null,
      ahead: null,
      behind: null,
      uniquePatchCount: null,
    });

    expect(await resolveOriginDefaultRef(repoDir)).toBeNull();
  });

  it("prefers refs/remotes/origin/HEAD for resolved origin default", async () => {
    setupOrigin(repoDir, tempDir);
    // Point origin/HEAD at a non-main default name if present; keep main and
    // ensure symbolic-ref is the resolution source.
    const resolved = await resolveOriginDefaultRef(repoDir);
    expect(resolved).toBe("origin/main");
  });

  it("reports unverifiable when refs/remotes/origin/HEAD is missing even if origin/main exists", async () => {
    setupOrigin(repoDir, tempDir);
    // Drop only the symbolic default; leave origin/main in place.
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/HEAD"], { cwd: repoDir });

    expect(await resolveOriginDefaultRef(repoDir)).toBeNull();
    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation).toEqual({
      state: "unverifiable",
      resolvedRef: null,
      ahead: null,
      behind: null,
      uniquePatchCount: null,
    });
  });

  it("reports unverifiable when origin/HEAD target is outside refs/remotes/origin/*", async () => {
    setupOrigin(repoDir, tempDir);
    // Malformed / wrong-namespace: point at a local heads ref instead of origin/*.
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main"], {
      cwd: repoDir,
    });

    expect(await resolveOriginDefaultRef(repoDir)).toBeNull();
    expect(await getOriginDefaultRelation(repoDir)).toEqual({
      state: "unverifiable",
      resolvedRef: null,
      ahead: null,
      behind: null,
      uniquePatchCount: null,
    });
  });

  it("reports unverifiable when origin/HEAD target ref is missing", async () => {
    setupOrigin(repoDir, tempDir);
    execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/does-not-exist"],
      { cwd: repoDir },
    );

    expect(await resolveOriginDefaultRef(repoDir)).toBeNull();
    expect(await getOriginDefaultRelation(repoDir)).toEqual({
      state: "unverifiable",
      resolvedRef: null,
      ahead: null,
      behind: null,
      uniquePatchCount: null,
    });
  });

  it("does not fall back to local main/master for originDefaultRelation safety", async () => {
    // Local main exists (from init) but no origin remote / origin/HEAD.
    writeFileSync(join(repoDir, "local-only.txt"), "local\n");
    execFileSync("git", ["add", "local-only.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "local only"], { cwd: repoDir });

    expect(await resolveOriginDefaultRef(repoDir)).toBeNull();
    const relation = await getOriginDefaultRelation(repoDir);
    expect(relation.state).toBe("unverifiable");
    expect(relation.resolvedRef).toBeNull();
    expect(relation.ahead).toBeNull();
    expect(relation.behind).toBeNull();
    expect(relation.uniquePatchCount).toBeNull();
  });
});
