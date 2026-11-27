import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runWithRepositoryRoot } from "./git-repository-discovery.js";
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
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "paseo-git-discovery-")));
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

function listedWorktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
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

  it("does not adopt a bare repository at the working directory even with linked worktrees", async () => {
    const { bareRepo, worktree } = createBareRepositoryWithLinkedWorktree(makeTempDir());

    await expect(
      runGitCommand(["worktree", "list", "--porcelain"], { cwd: bareRepo }),
    ).rejects.toThrow(/cannot use bare repository/);
    const fromWorktree = await runGitCommand(["rev-parse", "--git-common-dir"], { cwd: worktree });
    expect(path.resolve(worktree, fromWorktree.stdout.trim())).toBe(bareRepo);
  });

  it("runs at a bare repository root named with runWithRepositoryRoot", async () => {
    const { bareRepo, worktree } = createBareRepositoryWithLinkedWorktree(makeTempDir());

    const fromRoot = await runWithRepositoryRoot(bareRepo, () =>
      runGitCommand(["worktree", "list", "--porcelain"], { cwd: bareRepo }),
    );
    const belowRoot = await runWithRepositoryRoot(bareRepo, () =>
      runGitCommand(["rev-parse", "--absolute-git-dir"], { cwd: path.join(bareRepo, "refs") }),
    ).catch((error: unknown) => error);

    expect(listedWorktreePaths(fromRoot.stdout)).toContain(worktree);
    expect(String(belowRoot)).toMatch(/cannot use bare repository/);
  });
});
