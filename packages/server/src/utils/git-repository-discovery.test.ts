import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSafeBareRepositorySupport,
  readRepositoryRootGitDir,
  resolveGitDiscovery,
  runWithRepositoryRoot,
  type GitDiscovery,
} from "./git-repository-discovery.js";

const EXPLICIT = ["-c", "safe.bareRepository=explicit"];
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function makeTempDir(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "paseo-git-discovery-")));
  tempDirs.push(dir);
  return dir;
}

function createBareRepositoryWithLinkedWorktree(root: string): string {
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
  git(["worktree", "add", "-q", path.join(root, "main"), "main"], bareRepo);
  return bareRepo;
}

// Runs git with only the discovery environment, as a Git release that ignores
// `safe.bareRepository` would see it.
function gitDirWithoutConfig(cwd: string, discovery: GitDiscovery): string {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...discovery.envOverlay },
    }).trim();
    return path.resolve(gitDir);
  } catch (error) {
    return String((error as { stderr?: string }).stderr).trim();
  }
}

describe("resolveGitDiscovery before Git 2.38", () => {
  const legacy = {
    gitDirSet: false,
    repositoryRootGitDir: null,
    safeBareRepositorySupported: false,
  };

  it("stops git at a bare repository layout in the working directory", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);

    const discovery = await resolveGitDiscovery({ cwd: layout, ...legacy });

    expect(discovery.envOverlay).toEqual({ GIT_DIR: path.join(layout, ".git") });
    expect(gitDirWithoutConfig(layout, discovery)).toMatch(/not a git repository/);
  });

  it("stops git at a bare repository layout in a parent directory", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);
    const nested = path.join(layout, "a", "b");
    mkdirSync(nested, { recursive: true });

    const discovery = await resolveGitDiscovery({ cwd: nested, ...legacy });

    expect(discovery.envOverlay).toEqual({ GIT_DIR: path.join(nested, ".git") });
    expect(gitDirWithoutConfig(nested, discovery)).toMatch(/not a git repository/);
  });

  it("leaves discovery alone when a checkout sits between the directory and the layout", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);
    const checkout = path.join(layout, "checkout");
    git(["init", "-q", checkout]);
    const nested = path.join(checkout, "src");
    mkdirSync(nested);

    const discovery = await resolveGitDiscovery({ cwd: nested, ...legacy });

    expect(discovery).toEqual({ configArgs: EXPLICIT, envOverlay: {} });
    expect(gitDirWithoutConfig(nested, discovery)).toBe(path.join(checkout, ".git"));
  });

  it("leaves discovery alone inside a checkout's own .git directory", async () => {
    const checkout = path.join(makeTempDir(), "checkout");
    git(["init", "-q", checkout]);
    const gitDir = path.join(checkout, ".git");

    const discovery = await resolveGitDiscovery({ cwd: gitDir, ...legacy });

    expect(discovery).toEqual({ configArgs: EXPLICIT, envOverlay: {} });
  });

  it("stops git at a bare repository with linked worktrees unless its root is named", async () => {
    const bareRepo = createBareRepositoryWithLinkedWorktree(makeTempDir());

    const unnamed = await resolveGitDiscovery({ cwd: bareRepo, ...legacy });
    const named = await resolveGitDiscovery({
      cwd: bareRepo,
      ...legacy,
      repositoryRootGitDir: bareRepo,
    });

    expect(unnamed.envOverlay).toEqual({ GIT_DIR: path.join(bareRepo, ".git") });
    expect(named).toEqual({ configArgs: EXPLICIT, envOverlay: { GIT_DIR: bareRepo } });
    expect(gitDirWithoutConfig(bareRepo, named)).toBe(bareRepo);
  });

  it("stops git below a bare repository with linked worktrees", async () => {
    const bareRepo = createBareRepositoryWithLinkedWorktree(makeTempDir());
    const refs = path.join(bareRepo, "refs");

    const discovery = await resolveGitDiscovery({ cwd: refs, ...legacy });

    expect(discovery.envOverlay).toEqual({ GIT_DIR: path.join(refs, ".git") });
  });

  it("keeps a GIT_DIR the caller already chose", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);

    const discovery = await resolveGitDiscovery({
      cwd: layout,
      gitDirSet: true,
      repositoryRootGitDir: layout,
      safeBareRepositorySupported: false,
    });

    expect(discovery).toEqual({ configArgs: EXPLICIT, envOverlay: {} });
  });
});

describe("resolveGitDiscovery on Git 2.38 and later", () => {
  it("relies on safe.bareRepository instead of walking the directory tree", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);

    const discovery = await resolveGitDiscovery({
      cwd: layout,
      gitDirSet: false,
      repositoryRootGitDir: null,
      safeBareRepositorySupported: true,
    });

    expect(discovery).toEqual({ configArgs: EXPLICIT, envOverlay: {} });
  });

  it("names a bare repository root that the caller scoped", async () => {
    const layout = path.join(makeTempDir(), "layout");
    git(["init", "--bare", "-q", layout]);

    const discovery = await resolveGitDiscovery({
      cwd: layout,
      gitDirSet: false,
      repositoryRootGitDir: layout,
      safeBareRepositorySupported: true,
    });

    expect(discovery).toEqual({ configArgs: EXPLICIT, envOverlay: { GIT_DIR: layout } });
  });
});

describe("runWithRepositoryRoot", () => {
  it("names a bare repository root only for commands at that root", async () => {
    const bareRepo = path.join(makeTempDir(), "repo.git");
    git(["init", "--bare", "-q", bareRepo]);

    const inside = await runWithRepositoryRoot(bareRepo, async () => ({
      root: readRepositoryRootGitDir(bareRepo),
      below: readRepositoryRootGitDir(path.join(bareRepo, "refs")),
    }));

    expect(inside).toEqual({ root: bareRepo, below: null });
    expect(readRepositoryRootGitDir(bareRepo)).toBeNull();
  });

  it("leaves a checkout root to normal discovery", async () => {
    const checkout = path.join(makeTempDir(), "checkout");
    git(["init", "-q", checkout]);

    const named = await runWithRepositoryRoot(checkout, async () =>
      readRepositoryRootGitDir(checkout),
    );

    expect(named).toBeNull();
  });
});

describe("parseSafeBareRepositorySupport", () => {
  it.each([
    ["git version 2.53.0", true],
    ["git version 2.38.0", true],
    ["git version 2.45.1.windows.1", true],
    ["git version 3.0.0", true],
    ["git version 2.37.1 (Apple Git-137)", false],
    ["git version 2.34.1", false],
    ["git version 1.9.5", false],
    ["unexpected output", false],
  ])("%s → %s", (output, supported) => {
    expect(parseSafeBareRepositorySupport(output)).toBe(supported);
  });
});
