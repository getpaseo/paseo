import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-fsmonitor-"));
  tempDirs.push(repo);
  return repo;
}

async function configureFsmonitor(repo: string): Promise<string> {
  const hookPath = path.join(repo, "fsmonitor-hook.sh");
  const markerPath = `${hookPath}.marker`;
  writeFileSync(hookPath, "#!/bin/sh\n: > \"$0.marker\"\nprintf '1\\n'\n");
  chmodSync(hookPath, 0o755);
  await runGitCommand(["config", "core.fsmonitor", hookPath], { cwd: repo });
  return markerPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand fsmonitor isolation", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const markerPath = await configureFsmonitor(repo);

    await runGitCommand(["status", "--porcelain"], { cwd: repo });

    expect(existsSync(markerPath)).toBe(false);
  });

  it("overrides core.fsmonitor for commands other than status", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    await configureFsmonitor(repo);

    const result = await runGitCommand(["config", "--get", "core.fsmonitor"], { cwd: repo });

    expect(result.stdout.trim()).toBe("false");
  });
});

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-git-discovery-")));
  tempDirs.push(dir);
  return dir;
}

// Files shaped like a bare repository (`HEAD`, `config`, `objects/`, `refs/`) that
// git would adopt implicitly, with a clean filter that leaves a marker when run.
function createBareRepositoryLayout(root: string, name: string): { dir: string; marker: string } {
  const dir = path.join(root, name);
  git(["init", "--bare", "-q", dir]);
  const marker = path.join(root, `${name}.marker`);
  writeFileSync(path.join(dir, "info", "attributes"), "* filter=probe\n");
  git(["config", "-f", path.join(dir, "config"), "filter.probe.clean", `touch '${marker}'; cat`]);
  return { dir, marker };
}

function createBareRepositoryWithLinkedWorktree(root: string): {
  bareRepo: string;
  worktree: string;
} {
  const source = path.join(root, "source");
  git(["init", "-q", "-b", "main", source]);
  git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    ],
    source,
  );
  const bareRepo = path.join(root, "repo.git");
  git(["clone", "-q", "--bare", source, bareRepo]);
  const worktree = path.join(root, "main");
  git(["worktree", "add", "-q", worktree, "main"], bareRepo);
  return { bareRepo, worktree };
}

describe("runGitCommand repository discovery", () => {
  it("does not adopt a bare repository layout at the working directory", async () => {
    const root = makeTempDir();
    const layout = createBareRepositoryLayout(root, "layout");
    writeFileSync(path.join(layout.dir, "f.txt"), "contents\n");

    await runGitCommand(["hash-object", "--path=f.txt", "f.txt"], { cwd: layout.dir });

    expect(existsSync(layout.marker)).toBe(false);
    await expect(
      runGitCommand(["rev-parse", "--absolute-git-dir"], { cwd: layout.dir }),
    ).rejects.toThrow(/cannot use bare repository/);
  });

  it("does not adopt a bare repository layout in a parent directory", async () => {
    const root = makeTempDir();
    const layout = createBareRepositoryLayout(root, "layout");
    const nested = path.join(layout.dir, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "f.txt"), "contents\n");

    await runGitCommand(["hash-object", "--path=f.txt", "f.txt"], { cwd: nested });

    expect(existsSync(layout.marker)).toBe(false);
    await expect(
      runGitCommand(["rev-parse", "--absolute-git-dir"], { cwd: nested }),
    ).rejects.toThrow(/cannot use bare repository/);
  });

  it("does not adopt a bare repository layout whose worktrees directory is a symlink", async () => {
    const root = makeTempDir();
    const { bareRepo } = createBareRepositoryWithLinkedWorktree(root);
    const layout = createBareRepositoryLayout(root, "layout");
    symlinkSync(path.join(bareRepo, "worktrees"), path.join(layout.dir, "worktrees"));

    await expect(
      runGitCommand(["rev-parse", "--absolute-git-dir"], { cwd: layout.dir }),
    ).rejects.toThrow(/cannot use bare repository/);
  });

  it("does not adopt a bare repository layout whose worktree entry belongs to another repository", async () => {
    const root = makeTempDir();
    const { worktree } = createBareRepositoryWithLinkedWorktree(root);
    const layout = createBareRepositoryLayout(root, "layout");
    const adminDir = path.join(layout.dir, "worktrees", "main");
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(path.join(adminDir, "gitdir"), `${path.join(worktree, ".git")}\n`);

    await expect(
      runGitCommand(["rev-parse", "--absolute-git-dir"], { cwd: layout.dir }),
    ).rejects.toThrow(/cannot use bare repository/);
  });

  it("runs in a bare repository that a linked worktree points back to", async () => {
    const root = makeTempDir();
    const { bareRepo, worktree } = createBareRepositoryWithLinkedWorktree(root);

    const fromBare = await runGitCommand(["worktree", "list", "--porcelain"], { cwd: bareRepo });
    const fromWorktree = await runGitCommand(["rev-parse", "--git-common-dir"], { cwd: worktree });

    expect(fromBare.stdout).toContain(`worktree ${worktree}\n`);
    expect(path.resolve(worktree, fromWorktree.stdout.trim())).toBe(bareRepo);
  });
});
