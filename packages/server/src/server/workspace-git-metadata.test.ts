import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  buildWorkspaceGitMetadataFromSnapshot,
  deriveProjectSlug,
  parseGitHubRepoNameFromRemote,
} from "./workspace-git-metadata.js";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createWorkspace(directoryName: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `${directoryName}-`));
}

function createGitWorkspace(directoryName: string, remoteUrl?: string): string {
  const cwd = createWorkspace(directoryName);
  runGit(cwd, ["init"]);
  if (remoteUrl !== undefined) {
    runGit(cwd, ["config", "remote.origin.url", remoteUrl]);
  }
  return cwd;
}

describe("parseGitHubRepoNameFromRemote", () => {
  test.each([
    ["https://github.com/anthropics/claude-code.git", "claude-code"],
    ["http://github.com/anthropics/claude-code.git", "claude-code"],
    ["git@github.com:anthropics/claude-code.git", "claude-code"],
    ["ssh://git@github.com/anthropics/claude-code.git", "claude-code"],
    ["https://github.com/anthropics/claude-code", "claude-code"],
    ["https://github.com/acme/repo.with.dots.git", "repo.with.dots"],
    ["https://github.com/acme/Claude Code.git", "Claude Code"],
    ["https://github.com/acme/Repo_Name! 2026.git", "Repo_Name! 2026"],
  ])("extracts %s as %s", (remoteUrl, repoName) => {
    expect(parseGitHubRepoNameFromRemote(remoteUrl)).toBe(repoName);
  });

  test("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRepoNameFromRemote("git@gitlab.com:anthropics/claude-code.git")).toBeNull();
  });

  test.each([
    "https://gitlab.example/mirror/github.com/acme/claude-code.git",
    "ssh://git@gitlab.example/mirror/github.com/acme/claude-code.git",
  ])("returns null for embedded GitHub paths in non-GitHub remotes: %s", (remoteUrl) => {
    expect(parseGitHubRepoNameFromRemote(remoteUrl)).toBeNull();
  });
});

describe("deriveProjectSlug", () => {
  let tmpDirs: string[];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const tmpDir of tmpDirs) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function track(cwd: string): string {
    tmpDirs.push(cwd);
    return cwd;
  }

  test.each([
    ["https://github.com/acme/repo.with.dots.git", "repo-with-dots"],
    ["http://github.com/acme/http-repo.git", "http-repo"],
    ["git@github.com:acme/scp-repo.git", "scp-repo"],
    ["ssh://git@github.com/acme/ssh-repo.git", "ssh-repo"],
    ["https://github.com/acme/Claude Code.git", "claude-code"],
    ["https://github.com/acme/Repo_Name! 2026.git", "repo-name-2026"],
  ])("slugifies the GitHub repo name from %s", (remoteUrl, expectedSlug) => {
    const cwd = track(createGitWorkspace("fallback-name", remoteUrl));

    expect(deriveProjectSlug(cwd, remoteUrl)).toBe(expectedSlug);
  });

  test("uses only the repo name, so identical repo names collide across owners", () => {
    const acmeCwd = track(
      createGitWorkspace("acme-fallback", "https://github.com/acme/claude-code"),
    );
    const otherCwd = track(
      createGitWorkspace("other-fallback", "https://github.com/other/claude-code"),
    );

    expect(deriveProjectSlug(acmeCwd, "https://github.com/acme/claude-code")).toBe("claude-code");
    expect(deriveProjectSlug(otherCwd, "https://github.com/other/claude-code")).toBe("claude-code");
  });

  test("falls through to the cwd basename for non-GitHub remotes", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "non-github-parent-")));
    const cwd = path.join(parentDir, "My Local Repo");
    mkdirSync(cwd);
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "remote.origin.url", "git@gitlab.com:acme/claude-code.git"]);

    expect(deriveProjectSlug(cwd, "git@gitlab.com:acme/claude-code.git")).toBe("my-local-repo");
  });

  test("falls through to the cwd basename for embedded GitHub paths in non-GitHub remotes", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "embedded-github-parent-")));
    const cwd = path.join(parentDir, "Embedded GitHub Path");
    mkdirSync(cwd);
    runGit(cwd, ["init"]);
    runGit(cwd, [
      "config",
      "remote.origin.url",
      "https://gitlab.example/mirror/github.com/acme/claude-code.git",
    ]);

    expect(
      deriveProjectSlug(cwd, "https://gitlab.example/mirror/github.com/acme/claude-code.git"),
    ).toBe("embedded-github-path");
  });

  test("falls through to the cwd basename for an empty remote", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "empty-remote-parent-")));
    const cwd = path.join(parentDir, "Empty Remote Repo");
    mkdirSync(cwd);
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "remote.origin.url", ""]);

    expect(deriveProjectSlug(cwd)).toBe("empty-remote-repo");
  });

  test("falls through to the cwd basename when the remote is missing", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "missing-remote-parent-")));
    const cwd = path.join(parentDir, "Missing Remote Repo");
    mkdirSync(cwd);
    runGit(cwd, ["init"]);

    expect(deriveProjectSlug(cwd)).toBe("missing-remote-repo");
  });

  test("uses the cwd basename for a non-git directory", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "plain-parent-")));
    const cwd = path.join(parentDir, "Plain Directory");
    mkdirSync(cwd);

    expect(deriveProjectSlug(cwd)).toBe("plain-directory");
  });

  test("uses the cwd basename when no directory name is provided", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "basename-project-parent-")));
    const cwd = path.join(parentDir, "Basename Project!");
    mkdirSync(cwd);

    expect(deriveProjectSlug(cwd)).toBe("basename-project");
  });

  test("uses untitled when the project source collapses to an empty hostname label", () => {
    const parentDir = track(mkdtempSync(path.join(os.tmpdir(), "empty-project-parent-")));
    const cwd = path.join(parentDir, "日本語");
    mkdirSync(cwd);

    expect(deriveProjectSlug(cwd)).toBe("untitled");
  });
});

describe("buildWorkspaceGitMetadataFromSnapshot", () => {
  test("uses owner/repo as the display name for GitHub remotes", () => {
    const result = buildWorkspaceGitMetadataFromSnapshot({
      cwd: "/repos/some-dir",
      directoryName: "some-dir",
      isGit: true,
      repoRoot: "/repos/some-dir",
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "git@github.com:acme/widgets.git",
    });

    expect(result.projectDisplayName).toBe("acme/widgets");
  });

  test("uses owner/repo as the display name for non-GitHub remotes", () => {
    const result = buildWorkspaceGitMetadataFromSnapshot({
      cwd: "/repos/random-name",
      directoryName: "random-name",
      isGit: true,
      repoRoot: "/repos/random-name",
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "git@gitlab.com:acme/app.git",
    });

    expect(result.projectDisplayName).toBe("acme/app");
  });

  test("falls back to the directory name when there is no remote", () => {
    const result = buildWorkspaceGitMetadataFromSnapshot({
      cwd: "/repos/local-only",
      directoryName: "local-only",
      isGit: true,
      repoRoot: "/repos/local-only",
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: null,
    });

    expect(result.projectDisplayName).toBe("local-only");
  });
});
