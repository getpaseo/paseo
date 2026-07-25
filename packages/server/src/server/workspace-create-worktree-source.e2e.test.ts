import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// The reshaped workspace.create.request forwards its worktree `source`
// (action/refName/branchName/githubPrNumber/worktreeSlug) into createWorktreeCore.
// The regression these tests guard against is the daemon dropping action/refName
// while subsetting the request. We prove forwarding through the real workflow:
// the created worktree's observable branch is the only honest evidence the
// request fields reached git.

function createGitRepoWithBranch(): { repoDir: string; tempRoot: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "workspace-create-worktree-source-"));
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  // An existing branch the checkout action must target by refName.
  execFileSync("git", ["branch", "feature/existing-branch"], { cwd: repoDir, stdio: "pipe" });
  return { repoDir, tempRoot };
}

test("workspace.create worktree source forwards action=checkout + refName into the real worktree", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "checkout",
        refName: "feature/existing-branch",
      },
    });

    expect(result.error).toBeNull();
    // If action/refName were dropped, the daemon would branch-off a generated
    // slug instead of checking out the named branch. The created worktree being
    // on feature/existing-branch is the observable proof both fields forwarded.
    expect(result.workspace?.gitRuntime?.currentBranch).toBe("feature/existing-branch");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);

test("workspace.create keeps a branch-off name separate from its worktree slug", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        branchName: "feature/auth",
        worktreeSlug: "feature-auth",
        baseBranch: "main",
      },
    });

    expect(result.error).toBeNull();
    expect(result.workspace?.gitRuntime?.currentBranch).toBe("feature/auth");
    expect(path.basename(result.workspace?.workspaceDirectory ?? "")).toBe("feature-auth");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);

test("workspace.create materializes .worktreeinclude copies and symlinks", async () => {
  const daemon = await createTestPaseoDaemon();
  const { repoDir, tempRoot } = createGitRepoWithBranch();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    writeFileSync(
      path.join(repoDir, ".worktreeinclude"),
      ["copy.env", "# @symlink", "linked.txt", ""].join("\n"),
    );
    writeFileSync(path.join(repoDir, "copy.env"), "copy-v1\n");
    writeFileSync(path.join(repoDir, "linked.txt"), "linked-v1\n");
    await client.connect();

    const result = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        branchName: "feature/include-e2e",
        worktreeSlug: "include-e2e",
        baseBranch: "main",
      },
    });

    expect(result.error).toBeNull();
    const worktreePath = result.workspace?.workspaceDirectory;
    if (!worktreePath) {
      throw new Error("workspace.create did not return a worktree directory");
    }

    expect(readFileSync(path.join(worktreePath, "copy.env"), "utf8")).toBe("copy-v1\n");
    expect(lstatSync(path.join(worktreePath, "linked.txt")).isSymbolicLink()).toBe(true);

    writeFileSync(path.join(repoDir, "copy.env"), "copy-v2\n");
    writeFileSync(path.join(repoDir, "linked.txt"), "linked-v2\n");

    expect(readFileSync(path.join(worktreePath, "copy.env"), "utf8")).toBe("copy-v1\n");
    expect(readFileSync(path.join(worktreePath, "linked.txt"), "utf8")).toBe("linked-v2\n");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);
