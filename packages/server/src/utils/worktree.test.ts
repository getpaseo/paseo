import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
  isPaseoOwnedWorktreeCwd,
  mapWorkspaceCwdToWorktree,
  slugify,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRealpathAwarePathMatcher } from "./path";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

describe("paseo worktree manager", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("treats a worktree as paseo-owned even when its .git admin is missing", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-admin-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-admin",
      paseoHome,
    });

    // Simulate a previous archive attempt that removed git's admin dir but left
    // the working tree on disk (e.g. because file churn prevented full cleanup).
    rmSync(join(repoDir, ".git", "worktrees", "orphan-admin"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    await expect(
      isPaseoOwnedWorktreeCwd(join(created.worktreePath, "packages", "app"), { paseoHome }),
    ).resolves.toMatchObject({
      allowed: true,
      worktreePath: created.worktreePath,
    });
  });

  it("rejects paths that are not under the paseo worktrees root", async () => {
    const outsidePath = join(tempDir, "outside-paseo-home");
    mkdirSync(outsidePath, { recursive: true });

    const ownership = await isPaseoOwnedWorktreeCwd(outsidePath, { paseoHome });

    expect(ownership.allowed).toBe(false);
  });

  it("reports the source checkout root separately from Git's common directory", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "placement-root-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "placement-root",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });

    expect(ownership.allowed).toBe(true);
    expect(createRealpathAwarePathMatcher(repoDir)(ownership.repoRoot ?? "")).toBe(true);
    expect(createRealpathAwarePathMatcher(created.worktreePath)(ownership.worktreePath ?? "")).toBe(
      true,
    );
  });

  it("maps only root-contained workspace paths into a replacement worktree", () => {
    const sourceWorktreePath = join(tempDir, "source-worktree");
    const targetWorktreePath = join(tempDir, "target-worktree");
    const nestedWorkspaceCwd = join(sourceWorktreePath, "packages", "app");

    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: sourceWorktreePath,
        targetWorktreePath,
      }),
    ).toBe(targetWorktreePath);
    expect(
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: nestedWorkspaceCwd,
        targetWorktreePath,
      }),
    ).toBe(join(targetWorktreePath, "packages", "app"));
    expect(() =>
      mapWorkspaceCwdToWorktree({
        sourceWorktreePath,
        workspaceCwd: join(tempDir, "outside-worktree"),
        targetWorktreePath,
      }),
    ).toThrow("outside its source worktree");
  });

  it.skipIf(process.platform === "win32")(
    "maps a realpath-equivalent source workspace into the matching target subdirectory",
    () => {
      const sourceWorktreePath = join(tempDir, "source-worktree");
      const workspaceCwd = join(sourceWorktreePath, "packages", "app");
      const sourceAlias = join(tempDir, "source-alias");
      const targetWorktreePath = join(tempDir, "target-worktree");
      mkdirSync(workspaceCwd, { recursive: true });
      symlinkSync(sourceWorktreePath, sourceAlias, "dir");

      expect(
        mapWorkspaceCwdToWorktree({
          sourceWorktreePath: sourceAlias,
          workspaceCwd,
          targetWorktreePath,
        }),
      ).toBe(join(targetWorktreePath, "packages", "app"));
    },
  );

  it("rejects the worktrees root itself and the per-repo hash dir", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    const worktreesRoot = join(paseoHome, "worktrees");
    const projectHashDir = join(worktreesRoot, projectHash);
    mkdirSync(projectHashDir, { recursive: true });

    await expect(isPaseoOwnedWorktreeCwd(worktreesRoot, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
    await expect(isPaseoOwnedWorktreeCwd(projectHashDir, { paseoHome })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("deletes a worktree whose .git admin dir has already been removed", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "orphan-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "orphan-delete",
      paseoHome,
    });

    rmSync(join(repoDir, ".git", "worktrees", "orphan-delete"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    await deletePaseoWorktree({
      cwd: repoDir,
      worktreePath: created.worktreePath,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("is idempotent: deleting an already-absent worktree succeeds", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "idempotent-delete-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "idempotent-delete",
      paseoHome,
    });

    await deletePaseoWorktree({
      cwd: repoDir,
      worktreePath: created.worktreePath,
      paseoHome,
    });
    expect(existsSync(created.worktreePath)).toBe(false);

    // Second call — nothing left on disk and no admin entry — must not throw.
    await expect(
      deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
    ).resolves.toBeUndefined();
  });

  it("deletes a worktree when the parent repo root is not available", async () => {
    const created = await createLegacyWorktreeForTest({
      branchName: "no-cwd-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "no-cwd",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(created.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    expect(ownership.worktreeRoot).toBeTruthy();

    // Simulate the handler path when git has forgotten about the worktree:
    // caller forwards the path-derived worktreesRoot from the ownership check.
    await deletePaseoWorktree({
      cwd: null,
      worktreePath: created.worktreePath,
      worktreesRoot: ownership.worktreeRoot,
      paseoHome,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
  });
});

describe("slugify", () => {
  function expectValidHostnameLabel(label: string): void {
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  }

  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("FOO_BAR")).toBe("foo-bar");
    expect(slugify("My GREAT App")).toBe("my-great-app");
  });

  it("replaces dots with hyphens", () => {
    expect(slugify("my.app")).toBe("my-app");
    expect(slugify("v1.2.3")).toBe("v1-2-3");
  });

  it("collapses multiple consecutive spaces to one hyphen", () => {
    expect(slugify("feature   cool    stuff")).toBe("feature-cool-stuff");
  });

  it("replaces slashes with hyphens", () => {
    expect(slugify("feature/cool stuff")).toBe("feature-cool-stuff");
    expect(slugify("owner/repo")).toBe("owner-repo");
  });

  it("strips unsupported unicode characters", () => {
    expect(slugify("café")).toBe("caf");
    expect(slugify("日本語")).toBe("");
  });

  it("removes leading and trailing punctuation", () => {
    expect(slugify("-foo-")).toBe("foo");
    expect(slugify("__bar__")).toBe("bar");
    expect(slugify(".baz.")).toBe("baz");
  });

  it("truncates long strings at word boundary", () => {
    const longInput =
      "https-stackoverflow-com-questions-68349031-only-run-actions-on-non-draft-pull-request";
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(50);
    expectValidHostnameLabel(result);
    expect(result).toBe("https-stackoverflow-com-questions-68349031-only");
  });

  it("truncates without trailing hyphen when no word boundary", () => {
    const longInput = "a".repeat(60);
    const result = slugify(longInput);
    expect(result.length).toBe(50);
    expect(result.endsWith("-")).toBe(false);
    expectValidHostnameLabel(result);
  });

  it("keeps very long names within the hostname label length limit", () => {
    const result = slugify("Beta Build ".repeat(12));

    expect(result.length).toBeLessThanOrEqual(63);
    expectValidHostnameLabel(result);
  });

  it("returns empty when names collapse to empty", () => {
    expect(slugify("---")).toBe("");
    expect(slugify("***")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("is idempotent for representative inputs", () => {
    const inputs = [
      "my.app",
      "feature/cool stuff",
      "  Café Launch  ",
      "__bar__",
      "Beta Build ".repeat(12),
      "release***candidate",
    ];

    for (const input of inputs) {
      const slug = slugify(input);
      expect(slugify(slug)).toBe(slug);
    }
  });
});
