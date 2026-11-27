import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertReleaseBranch, pushCurrentReleaseTag } from "./push-current-release-tag.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createReleaseRepoWithBareRemote(version = "0.17.0-beta.2") {
  const root = mkdtempSync(path.join(tmpdir(), "push-release-tag-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["checkout", "-b", `release/v${version}`]);
  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "paseo", version }, null, 2)}\n`,
  );
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "-q", "-m", `chore(release): cut ${version}`]);
  return { root, remote, repo };
}

test("accepts release/* branches for release pushes", () => {
  assert.doesNotThrow(() => assertReleaseBranch("release/v0.17.0-beta.2"));
  assert.doesNotThrow(() => assertReleaseBranch("release/v0.17.0"));
  assert.doesNotThrow(() => assertReleaseBranch("release/0.17.1-hotfix"));
});

test("refuses main and non-release branches for release pushes", () => {
  assert.throws(() => assertReleaseBranch("main"), /release\/\*/);
  assert.throws(() => assertReleaseBranch("feat/something"), /release\/\*/);
  assert.throws(() => assertReleaseBranch("release/"), /release\/\*/);
  assert.throws(() => assertReleaseBranch(""), /release\/\*/);
});

test("refuses to ship when HEAD has not been pushed to the remote release branch", () => {
  const { root, repo } = createReleaseRepoWithBareRemote("0.17.0-beta.2");
  try {
    // Never pushed yet: --check and full push both fail before publishing or tagging.
    assert.throws(() => pushCurrentReleaseTag(["--check"], { cwd: repo }), /does not match origin/);
    assert.throws(() => pushCurrentReleaseTag([], { cwd: repo }), /does not match origin/);

    // Push the verified commit, then add an unpushed local commit on top.
    git(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    assert.doesNotThrow(() => pushCurrentReleaseTag(["--check"], { cwd: repo }));

    writeFileSync(path.join(repo, "extra.txt"), "unverified\n");
    git(repo, ["add", "extra.txt"]);
    git(repo, ["commit", "-q", "-m", "extra local commit"]);

    assert.throws(() => pushCurrentReleaseTag(["--check"], { cwd: repo }), /does not match origin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrying release:push succeeds cleanly when the annotated tag already points at HEAD on origin", () => {
  const { root, repo } = createReleaseRepoWithBareRemote("0.17.0-beta.2");
  try {
    git(repo, ["push", "-q", "-u", "origin", "HEAD"]);
    const first = pushCurrentReleaseTag([], { cwd: repo });
    assert.equal(first.tag, "v0.17.0-beta.2");

    // Re-running after the annotated tag already exists on origin must not report a false SHA mismatch.
    const second = pushCurrentReleaseTag([], { cwd: repo });
    assert.equal(second.tag, "v0.17.0-beta.2");
    assert.equal(second.headCommit, first.headCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
