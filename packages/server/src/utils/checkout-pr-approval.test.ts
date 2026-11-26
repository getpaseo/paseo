import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capturePrCheckoutState, createPullRequest, getCurrentBranch } from "./checkout-git.js";
import { createGitHubService } from "../services/github-service.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function initializeRepo(root: string, name: string) {
  const repo = join(root, name);
  const remote = join(root, `${name}.git`);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "commit", "--allow-empty", "-m", "base");
  git(root, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return { repo, remote };
}

it.each(["branch-tag-collision", "equals-in-url"])(
  "preserves approved push identity for %s",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "paseo-pr-identity-"));
    try {
      const { repo, remote } = initializeRepo(
        root,
        scenario === "equals-in-url" ? "parent=destination" : "parent",
      );
      git(repo, "tag", "feature");
      git(repo, "switch", "-c", "feature");
      git(repo, "commit", "--allow-empty", "-m", "Approved");
      git(repo, "config", "remote.origin.proxy", "");
      const approved = await capturePrCheckoutState(repo, "main");
      expect(approved.head).toBe("feature");
      let createdHead = "";
      await createPullRequest(
        repo,
        {
          title: "Approved",
          head: approved.head,
          base: approved.base,
          approvedHeadSha: approved.headSha,
          approvedPushUrls: approved.pushUrls,
          approvedOriginConfig: approved.originConfig,
        },
        {
          ...createGitHubService(),
          createPullRequest: async (input) => {
            createdHead = input.head;
            return { url: "https://example.com/pull/1", number: 1 };
          },
        },
      );
      expect(createdHead).toBe("feature");
      expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature")).toBe(
        approved.headSha,
      );
      expect(git(repo, "config", "branch.feature.merge")).toBe("refs/heads/feature");
      expect(() =>
        git(root, "--git-dir", remote, "rev-parse", "refs/heads/heads/feature"),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["local", "symbolic"])(
  "does not rewind a local branch through a %s upstream mapping",
  async (mapping) => {
    const root = mkdtempSync(join(tmpdir(), "paseo-pr-upstream-"));
    try {
      const { repo, remote } = initializeRepo(root, "parent");
      git(repo, "switch", "-c", "feature");
      git(repo, "commit", "--allow-empty", "-m", "Approved");
      if (mapping === "local") {
        git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
      } else {
        git(repo, "symbolic-ref", "refs/remotes/origin/feature", "refs/heads/feature");
      }
      const approved = await capturePrCheckoutState(repo, "main");
      git(repo, "commit", "--allow-empty", "-m", "Newer local commit");
      const localTip = git(repo, "rev-parse", "HEAD");
      await createPullRequest(
        repo,
        {
          title: "Approved",
          head: approved.head,
          base: approved.base,
          approvedHeadSha: approved.headSha,
          approvedPushUrls: approved.pushUrls,
          approvedOriginConfig: approved.originConfig,
        },
        {
          ...createGitHubService(),
          createPullRequest: async () => ({ url: "https://example.com/pull/1", number: 1 }),
        },
      );
      expect(git(repo, "rev-parse", "HEAD")).toBe(localTip);
      expect(git(repo, "rev-parse", "refs/heads/feature")).toBe(localTip);
      expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature")).toBe(
        approved.headSha,
      );
      if (mapping === "symbolic")
        expect(git(repo, "symbolic-ref", "refs/remotes/origin/feature")).toBe("refs/heads/feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["tracked", "untracked"])(
  "pushes unpublished %s submodule branches on demand while pinning the parent",
  async (tracking) => {
    const root = mkdtempSync(join(tmpdir(), "paseo-pr-submodules-"));
    try {
      const { repo, remote } = initializeRepo(root, "parent");
      const sub = initializeRepo(root, "dependency");
      git(sub.repo, "symbolic-ref", "HEAD", "refs/heads/main");
      git(root, "--git-dir", sub.remote, "symbolic-ref", "HEAD", "refs/heads/main");
      git(repo, "-c", "protocol.file.allow=always", "submodule", "add", sub.remote, "dependency");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "Add dependency");
      git(repo, "switch", "-c", "feature");
      const checkout = join(repo, "dependency");
      git(checkout, "config", "user.name", "Test");
      git(checkout, "config", "user.email", "test@example.com");
      git(checkout, "config", "protocol.file.allow", "always");
      git(checkout, "config", "push.default", "simple");
      git(checkout, "switch", "-c", "feature");
      if (tracking === "tracked") {
        git(checkout, "config", "branch.feature.remote", "origin");
        git(checkout, "config", "branch.feature.merge", "refs/heads/feature");
      }
      const childUpstream = git(
        checkout,
        "for-each-ref",
        "--format=%(upstream)",
        "refs/heads/feature",
      );
      expect(childUpstream).toBe(tracking === "tracked" ? "refs/remotes/origin/feature" : "");
      writeFileSync(join(checkout, "change.txt"), "dependency change\n");
      git(checkout, "add", ".");
      git(checkout, "commit", "-m", "Unpublished dependency change");
      const dependencySha = git(checkout, "rev-parse", "HEAD");
      git(repo, "add", "dependency");
      git(repo, "commit", "-m", "Use dependency change");
      git(repo, "config", "push.recurseSubmodules", "on-demand");
      const approved = await capturePrCheckoutState(repo, "main");
      git(repo, "commit", "--allow-empty", "-m", "Not approved");
      let creations = 0;
      await createPullRequest(
        repo,
        {
          title: "Approved dependency change",
          head: approved.head,
          base: approved.base,
          approvedHeadSha: approved.headSha,
          approvedPushUrls: approved.pushUrls,
          approvedOriginConfig: approved.originConfig,
        },
        {
          ...createGitHubService(),
          createPullRequest: async () => {
            creations++;
            return { url: "https://example.com/pull/1", number: 1 };
          },
        },
      );
      expect(git(root, "--git-dir", remote, "rev-parse", "refs/heads/feature")).toBe(
        approved.headSha,
      );
      expect(git(root, "--git-dir", sub.remote, "rev-parse", "refs/heads/feature")).toBe(
        dependencySha,
      );
      expect(git(repo, "rev-parse", "HEAD")).not.toBe(approved.headSha);
      expect(creations).toBe(1);
      expect(git(checkout, "for-each-ref", "--format=%(upstream)", "refs/heads/feature")).toBe(
        childUpstream,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("rejects PR preparation while an interactive rebase is paused at an edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-pr-rebase-"));
  try {
    const { repo } = initializeRepo(root, "parent");
    git(repo, "switch", "-c", "feature");
    writeFileSync(join(repo, "one.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "First change");
    writeFileSync(join(repo, "two.txt"), "two\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Second change");
    git(repo, "-c", "sequence.editor=sed -i '1s/^pick /edit /'", "rebase", "-i", "main");
    expect(await getCurrentBranch(repo)).toBe("feature");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(git(repo, "rev-parse", "feature"));
    await expect(capturePrCheckoutState(repo, "main")).rejects.toThrow(
      "Finish the rebase or attach a branch before preparing a PR",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
