import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createWorktree } from "../../utils/worktree.js";
import {
  createDaemonTestContext,
  createTempGithubRepoName,
  type DaemonTestContext,
} from "../test-utils/index.js";

const cleanupContexts = new Set<DaemonTestContext>();
const cleanupPaths = new Set<string>();
const cleanupRepos = new Set<string>();

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, { cwd, stdio: "pipe" }).toString().trim();
}

function hasGitHubTestAccess(): boolean {
  try {
    const auth = run(process.cwd(), "gh", ["auth", "status", "-h", "github.com"]);
    return auth.length >= 0;
  } catch {
    return false;
  }
}

const githubTest = hasGitHubTestAccess() ? test : test.skip;

async function activeWorkspaceIds(context: DaemonTestContext): Promise<string[]> {
  return (await context.client.fetchWorkspaces()).entries.map((workspace) => workspace.id);
}

async function waitForWorkspaceToArchive(
  context: DaemonTestContext,
  workspaceId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await activeWorkspaceIds(context)).includes(workspaceId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace ${workspaceId} was not archived`);
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupContexts, (context) => context.cleanup().catch(() => undefined)),
  );
  cleanupContexts.clear();
  for (const repo of cleanupRepos) {
    try {
      run(process.cwd(), "gh", ["repo", "delete", repo, "--yes"]);
    } catch {
      // Preserve the original test failure; the temp-repo prefix supports bulk cleanup.
    }
  }
  cleanupRepos.clear();
  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

githubTest(
  "does not retarget a never-pushed workspace when its checkout moves onto a merged PR branch",
  async () => {
    const repository = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-github-merge-")));
    cleanupPaths.add(repository);
    run(repository, "git", ["init", "-b", "main"]);
    run(repository, "git", ["config", "user.email", "paseo-test@example.com"]);
    run(repository, "git", ["config", "user.name", "Paseo Test"]);
    writeFileSync(path.join(repository, "README.md"), "producer repro\n");
    run(repository, "git", ["add", "README.md"]);
    run(repository, "git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);

    const owner = run(repository, "gh", ["api", "user", "--jq", ".login"]);
    const repoName = createTempGithubRepoName("unrelated-merge");
    const repoFullName = `${owner}/${repoName}`;
    run(repository, "gh", [
      "api",
      "-X",
      "POST",
      "user/repos",
      "-f",
      `name=${repoName}`,
      "-f",
      "private=true",
    ]);
    cleanupRepos.add(repoFullName);
    const token = encodeURIComponent(run(repository, "gh", ["auth", "token"]));
    run(repository, "git", [
      "remote",
      "add",
      "origin",
      `https://x-access-token:${token}@github.com/${repoFullName}.git`,
    ]);
    run(repository, "git", ["push", "-u", "origin", "main"]);

    const context = await createDaemonTestContext({ autoArchiveAfterMerge: true });
    cleanupContexts.add(context);
    const merged = await createWorktree({
      cwd: repository,
      worktreeSlug: "merged-feature",
      source: { kind: "branch-off", baseBranch: "main", branchName: "merged-feature" },
      runSetup: false,
      paseoHome: context.daemon.paseoHome,
    });
    const unrelated = await createWorktree({
      cwd: repository,
      worktreeSlug: "never-pushed-unrelated",
      source: { kind: "branch-off", baseBranch: "main", branchName: "never-pushed-unrelated" },
      runSetup: false,
      paseoHome: context.daemon.paseoHome,
    });
    const mergedWorkspace = await context.client.createWorkspace({
      source: { kind: "directory", path: merged.worktreePath },
    });
    const unrelatedWorkspace = await context.client.createWorkspace({
      source: { kind: "directory", path: unrelated.worktreePath },
    });
    if (!mergedWorkspace.workspace || !unrelatedWorkspace.workspace) {
      throw new Error("Failed to register both worktrees");
    }
    await context.client.fetchWorkspaces({
      subscribe: { subscriptionId: "real-unrelated-merge" },
    });

    writeFileSync(path.join(merged.worktreePath, "feature.txt"), "merged\n");
    run(merged.worktreePath, "git", ["add", "feature.txt"]);
    run(merged.worktreePath, "git", [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "merged feature",
    ]);
    run(merged.worktreePath, "git", ["push", "-u", "origin", "merged-feature"]);
    const pullRequestUrl = run(merged.worktreePath, "gh", [
      "pr",
      "create",
      "--repo",
      repoFullName,
      "--base",
      "main",
      "--head",
      "merged-feature",
      "--title",
      "Merged feature",
      "--body",
      "Producer-level auto-archive reproduction.",
    ]);

    const beforeMerge = await activeWorkspaceIds(context);
    expect(beforeMerge).toEqual(
      expect.arrayContaining([mergedWorkspace.workspace.id, unrelatedWorkspace.workspace.id]),
    );
    run(merged.worktreePath, "gh", [
      "pr",
      "merge",
      pullRequestUrl,
      "--repo",
      repoFullName,
      "--squash",
      "--delete-branch",
    ]);

    expect((await context.client.checkoutRefresh(merged.worktreePath)).success).toBe(true);
    await waitForWorkspaceToArchive(context, mergedWorkspace.workspace.id);

    expect((await context.client.checkoutRefresh(unrelated.worktreePath)).success).toBe(true);
    const unrelatedStatus = await context.client.checkoutPrStatus(unrelated.worktreePath);
    expect(unrelatedStatus.status).toBeNull();
    expect(await activeWorkspaceIds(context)).toContain(unrelatedWorkspace.workspace.id);

    // The workspace remains identified by the branch it was created for. Moving the
    // checkout does not silently retarget its PR association or archive identity.
    run(merged.worktreePath, "git", ["checkout", "--detach"]);
    run(unrelated.worktreePath, "git", ["checkout", "merged-feature"]);
    expect((await context.client.checkoutRefresh(unrelated.worktreePath)).success).toBe(true);
    const switchedStatus = await context.client.checkoutPrStatus(unrelated.worktreePath);
    expect(switchedStatus.status).toBeNull();
    expect(await activeWorkspaceIds(context)).toContain(unrelatedWorkspace.workspace.id);
  },
  180_000,
);
