import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { auditReleaseSources } from "./local-release-inventory.mjs";
const temporary = [];
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-inventory-")));
  temporary.push(root);
  git(root, "init", "-b", "paseo-local");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Release test");
  writeFileSync(path.join(root, "feature.txt"), "base");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return { root, commit: git(root, "rev-parse", "HEAD") };
}
afterEach(() =>
  temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);
test("blocks a candidate that omits a completed local branch, then accepts its merge", () => {
  const { root, commit } = fixture();
  git(root, "switch", "-c", "browser-tabs");
  writeFileSync(path.join(root, "feature.txt"), "tabs");
  git(root, "commit", "-am", "tabs");
  const missing = git(root, "rev-parse", "HEAD");
  git(root, "switch", "paseo-local");
  expect(auditReleaseSources({ root, commit, repositories: [root] }).blockers).toEqual([
    expect.objectContaining({ kind: "unmerged", ref: "refs/heads/browser-tabs", commit: missing }),
  ]);
  git(root, "merge", "--ff-only", "browser-tabs");
  expect(auditReleaseSources({ root, commit: missing, repositories: [root] }).blockers).toEqual([]);
});
test("blocks modified and untracked work in every linked checkout, including detached heads", () => {
  const { root, commit } = fixture();
  const worktree = path.join(root, "work");
  git(root, "worktree", "add", "--detach", worktree, commit);
  writeFileSync(path.join(root, ".gitignore"), "work/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore worktree");
  const candidate = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(worktree, "feature.txt"), "unfinished");
  writeFileSync(path.join(worktree, "new.ts"), "uncommitted");
  const dirty = auditReleaseSources({ root, commit: candidate, repositories: [root] }).blockers;
  expect(dirty).toEqual([expect.objectContaining({ kind: "dirty", worktree })]);
  expect(dirty[0].files).toContain("new.ts");
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "detached work");
  expect(auditReleaseSources({ root, commit: candidate, repositories: [root] }).blockers).toEqual([
    expect.objectContaining({
      kind: "unmerged",
      ref: worktree,
      commit: git(worktree, "rev-parse", "HEAD"),
    }),
  ]);
});
test("audits a separate source repository without moving its branches", () => {
  const { root } = fixture();
  const builder = path.join(root, "builder");
  git(root, "clone", ".", builder);
  writeFileSync(path.join(root, ".gitignore"), "builder/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "source change");
  const sourceHead = git(root, "rev-parse", "HEAD");
  git(builder, "fetch", "origin");
  git(builder, "merge", "--ff-only", "origin/paseo-local");
  git(builder, "config", "user.email", "test@example.com");
  git(builder, "config", "user.name", "Test");
  writeFileSync(path.join(builder, "release.txt"), "release");
  git(builder, "add", ".");
  git(builder, "commit", "-m", "candidate");
  const commit = git(builder, "rev-parse", "HEAD");
  expect(auditReleaseSources({ root: builder, commit, repositories: [root] }).blockers).toEqual([]);
  expect(git(root, "rev-parse", "HEAD")).toBe(sourceHead);
});
test("fails closed without configured sources and writes an actionable audit report", async () => {
  const { assertReleaseInventory } = await import("./local-release-inventory.mjs");
  const { readFileSync, mkdirSync } = await import("node:fs");
  const { root, commit } = fixture();
  const state = path.join(root, "state");
  expect(() => assertReleaseInventory({ root, commit, state })).toThrow("sources");
  expect(
    JSON.parse(readFileSync(path.join(state, "source-audit.json"), "utf8")).blockers[0].kind,
  ).toBe("audit-error");
  writeFileSync(path.join(root, ".gitignore"), "state/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "ignore state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    path.join(state, "source-repositories.json"),
    JSON.stringify({ repositories: [root] }),
  );
  expect(
    assertReleaseInventory({ root, commit: git(root, "rev-parse", "HEAD"), state }).blockers,
  ).toEqual([]);
  writeFileSync(path.join(root, "unfinished.txt"), "new work");
  expect(() =>
    assertReleaseInventory({ root, commit: git(root, "rev-parse", "HEAD"), state }),
  ).toThrow("unfinished.txt");
});
test("checks only pushes to paseo-local and blocks release branch deletion", async () => {
  const { checkLocalReleasePush } = await import("./local-release-inventory.mjs");
  const { root, commit } = fixture();
  const state = path.join(root, "state");
  expect(() =>
    checkLocalReleasePush(`refs/heads/feature ${commit} refs/heads/feature ${commit}`, {
      root,
      state,
    }),
  ).not.toThrow();
  expect(() =>
    checkLocalReleasePush(`refs/heads/feature ${commit} refs/heads/paseo-local ${commit}`, {
      root,
      state,
    }),
  ).toThrow("sources");
  expect(() =>
    checkLocalReleasePush(`(delete) ${"0".repeat(40)} refs/heads/paseo-local ${commit}`, {
      root,
      state,
    }),
  ).toThrow("delete");
});

test("audits each checkout independently of the Git environment inherited by a push hook", () => {
  const { root, commit } = fixture();
  const worktree = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-push-worktree-")));
  temporary.push(worktree);
  git(root, "worktree", "add", "-b", "candidate", worktree, commit);
  writeFileSync(path.join(worktree, "feature.txt"), "candidate contents");
  git(worktree, "commit", "-am", "candidate");
  const candidate = git(worktree, "rev-parse", "HEAD");
  const directory = git(worktree, "rev-parse", "--absolute-git-dir");
  vi.stubEnv("GIT_DIR", directory);
  vi.stubEnv("GIT_INDEX_FILE", path.join(directory, "index"));
  vi.stubEnv("GIT_WORK_TREE", worktree);
  try {
    expect(auditReleaseSources({ root: worktree, commit: candidate }).blockers).toEqual([]);
    writeFileSync(path.join(root, "unfinished.txt"), "real unsaved work");
    expect(auditReleaseSources({ root: worktree, commit: candidate }).blockers).toEqual([
      expect.objectContaining({
        kind: "dirty",
        worktree: root,
        files: expect.stringContaining("unfinished.txt"),
      }),
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
});
