import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, test } from "vitest";
import type { GitHubService } from "../../../services/github-service.js";
import type {
  WorkspaceGitBranchValidationResult,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import { createGitMutationService } from "./git-mutation-service.js";

// The production module reads only WorkspaceGitService.{validateBranchRef,getSnapshot,hasLocalBranch}
// and GitHubService.invalidate. The fakes below implement exactly that slice as in-memory
// adapters; the happy-path tests cross the real git boundary against a temp repo, since that is
// where checkoutResolvedBranch / `git checkout -b` actually run.

type GitSource = Pick<WorkspaceGitService, "validateBranchRef" | "getSnapshot" | "hasLocalBranch">;

const logger = pino({ level: "silent" });

interface FakeGitOptions {
  resolution?: WorkspaceGitBranchValidationResult;
  isDirty?: boolean | null;
  branchExists?: boolean;
  getSnapshotThrows?: boolean;
}

function createFakeGit(opts: FakeGitOptions = {}) {
  const resolution = opts.resolution ?? { kind: "local", name: "main" };
  const isDirty = opts.isDirty ?? false;
  const branchExists = opts.branchExists ?? false;
  const snapshotCalls: Array<{ cwd: string; force: boolean; reason?: string }> = [];
  const git: GitSource = {
    async validateBranchRef() {
      return resolution;
    },
    async getSnapshot(cwd, options) {
      snapshotCalls.push({ cwd, force: options?.force === true, reason: options?.reason });
      if (opts.getSnapshotThrows) {
        throw new Error("snapshot boom");
      }
      return { git: { isDirty } } as unknown as WorkspaceGitRuntimeSnapshot;
    },
    async hasLocalBranch() {
      return branchExists;
    },
  };
  return { git, snapshotCalls };
}

function createFakeGithub() {
  const invalidateCalls: Array<{ cwd: string }> = [];
  const github: Pick<GitHubService, "invalidate"> = {
    invalidate(options) {
      invalidateCalls.push(options);
    },
  };
  return { github, invalidateCalls };
}

function buildService(gitOptions: FakeGitOptions = {}) {
  const { git, snapshotCalls } = createFakeGit(gitOptions);
  const { github, invalidateCalls } = createFakeGithub();
  const service = createGitMutationService({ workspaceGitService: git, github, logger });
  return { service, snapshotCalls, invalidateCalls };
}

const tempRepos: string[] = [];

function initRepo(extraBranch?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-mutation-")));
  tempRepos.push(dir);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Paseo Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  run("add", "-A");
  run("commit", "-m", "init");
  if (extraBranch) {
    run("branch", extraBranch);
  }
  return dir;
}

function headBranch(dir: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim();
}

afterEach(() => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("checkoutExistingBranch", () => {
  test("rejects an unsafe branch ref before touching git", async () => {
    const { service } = buildService();
    await expect(service.checkoutExistingBranch("/tmp/nope", "bad branch")).rejects.toThrow(
      /Invalid branch/,
    );
  });

  test("rejects when the branch does not resolve", async () => {
    const { service } = buildService({ resolution: { kind: "not-found" } });
    await expect(service.checkoutExistingBranch("/tmp/nope", "missing")).rejects.toThrow(
      /Branch not found: missing/,
    );
  });

  test("rejects when the working tree is dirty", async () => {
    const { service } = buildService({ resolution: { kind: "local", name: "x" }, isDirty: true });
    await expect(service.checkoutExistingBranch("/tmp/nope", "x")).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  test("wraps a git-status failure with the inspecting-status message", async () => {
    const { service } = buildService({
      resolution: { kind: "local", name: "x" },
      getSnapshotThrows: true,
    });
    await expect(service.checkoutExistingBranch("/tmp/nope", "x")).rejects.toThrow(
      /Unable to inspect git status/,
    );
  });

  test("checks out the branch and invalidates github (real repo)", async () => {
    const dir = initRepo("feature");
    const { service, snapshotCalls, invalidateCalls } = buildService({
      resolution: { kind: "local", name: "feature" },
    });
    const result = await service.checkoutExistingBranch(dir, "feature");
    expect(result.source).toBe("local");
    expect(headBranch(dir)).toBe("feature");
    expect(invalidateCalls).toEqual([{ cwd: dir }]);
    expect(snapshotCalls).toContainEqual({ cwd: dir, force: true, reason: "switch-branch" });
  });
});

describe("createBranchFromBase", () => {
  test("rejects an unsafe new-branch ref before touching git", async () => {
    const { service } = buildService({ resolution: { kind: "local", name: "main" } });
    await expect(
      service.createBranchFromBase({
        cwd: "/tmp/nope",
        baseBranch: "main",
        newBranchName: "bad x",
      }),
    ).rejects.toThrow(/Invalid new/);
  });

  test("rejects when the base branch does not resolve", async () => {
    const { service } = buildService({ resolution: { kind: "not-found" } });
    await expect(
      service.createBranchFromBase({ cwd: "/tmp/nope", baseBranch: "main", newBranchName: "feat" }),
    ).rejects.toThrow(/Base branch not found: main/);
  });

  test("rejects when the new branch already exists", async () => {
    const { service } = buildService({
      resolution: { kind: "local", name: "main" },
      branchExists: true,
    });
    await expect(
      service.createBranchFromBase({ cwd: "/tmp/nope", baseBranch: "main", newBranchName: "feat" }),
    ).rejects.toThrow(/Branch already exists: feat/);
  });

  test("rejects when the working tree is dirty", async () => {
    const { service } = buildService({
      resolution: { kind: "local", name: "main" },
      branchExists: false,
      isDirty: true,
    });
    await expect(
      service.createBranchFromBase({ cwd: "/tmp/nope", baseBranch: "main", newBranchName: "feat" }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  test("creates the branch from base and refreshes without github invalidation (real repo)", async () => {
    const dir = initRepo();
    const { service, snapshotCalls, invalidateCalls } = buildService({
      resolution: { kind: "local", name: "main" },
    });
    await service.createBranchFromBase({ cwd: dir, baseBranch: "main", newBranchName: "feature2" });
    expect(headBranch(dir)).toBe("feature2");
    expect(invalidateCalls).toEqual([]);
    expect(snapshotCalls).toContainEqual({ cwd: dir, force: true, reason: "create-branch" });
  });
});

describe("notifyGitMutation", () => {
  test("invalidates github and force-refreshes when invalidateGithub is set", async () => {
    const { service, snapshotCalls, invalidateCalls } = buildService();
    await service.notifyGitMutation("/tmp/repo", "commit-changes", { invalidateGithub: true });
    expect(invalidateCalls).toEqual([{ cwd: "/tmp/repo" }]);
    expect(snapshotCalls).toEqual([{ cwd: "/tmp/repo", force: true, reason: "commit-changes" }]);
  });

  test("force-refreshes without invalidating github by default", async () => {
    const { service, snapshotCalls, invalidateCalls } = buildService();
    await service.notifyGitMutation("/tmp/repo", "pull");
    expect(invalidateCalls).toEqual([]);
    expect(snapshotCalls).toEqual([{ cwd: "/tmp/repo", force: true, reason: "pull" }]);
  });

  test("swallows a snapshot-refresh failure", async () => {
    const { service } = buildService({ getSnapshotThrows: true });
    await expect(service.notifyGitMutation("/tmp/repo", "pull")).resolves.toBeUndefined();
  });
});
