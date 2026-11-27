import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CowExec,
  createWorktreeWithCowFallback,
  isExcludedCowEntry,
  supportsReflink,
} from "./cow-worktree.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function makeFixtureRepo(): { root: string; repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "paseo-cow-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.svelte-kit/\n.env*\n!.env.example\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, ".env.example"), "EXAMPLE=1\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const v = 1;\n");
  runGit(repo, ["add", ".gitignore", "pnpm-lock.yaml", ".env.example", "src/index.ts"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(repo, "node_modules", ".pnpm", "lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, ".env.local"), "SECRET=never-copy\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), "{}\n");
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const mockCopyExec: CowExec = (program, args) => {
  if (program === "git") {
    try {
      const stdout = execFileSync("git", args, { encoding: "utf8" });
      return { status: 0, stdout, stderr: "", error: null };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: err.status ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(error),
        error: null,
      };
    }
  }
  const src = args.at(-2);
  const dst = args.at(-1);
  if (!src || !dst) return { status: 1, stdout: "", stderr: "missing args", error: null };
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return { status: 0, stdout: "", stderr: "", error: null };
};

describe("cow-worktree", () => {
  it("excludes secrets and agent state while allowing tracked dotdirs and build caches", () => {
    const tracked = new Set([".github", ".gitignore", "src"]);
    expect(isExcludedCowEntry(".git", tracked)).toBe(true);
    expect(isExcludedCowEntry(".env", tracked)).toBe(true);
    expect(isExcludedCowEntry(".env.local", tracked)).toBe(true);
    expect(isExcludedCowEntry(".claude", tracked)).toBe(true);
    expect(isExcludedCowEntry(".paseo", tracked)).toBe(true);
    expect(isExcludedCowEntry("docker-compose.override.yml", tracked)).toBe(true);
    expect(isExcludedCowEntry(".github", tracked)).toBe(false);
    expect(isExcludedCowEntry(".svelte-kit", tracked)).toBe(false);
    expect(isExcludedCowEntry("node_modules", tracked)).toBe(false);
    expect(isExcludedCowEntry("src", tracked)).toBe(false);
  });

  it("probes reflink support and cleans up probe files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-cow-probe-"));
    try {
      const ok = await supportsReflink(dir, { platform: "linux", exec: mockCopyExec });
      expect(ok).toEqual({ supported: true, mechanism: "reflink", reason: null });
      expect(readdirSync(dir)).toEqual([]);

      const fail = await supportsReflink(dir, {
        platform: "linux",
        exec: () => ({ status: 1, stdout: "", stderr: "Operation not supported", error: null }),
      });
      expect(fail).toEqual({ supported: false, mechanism: null, reason: "reflink-unsupported" });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clones warm seed under lock, excludes secrets, restores excluded tracked files, and handles dirty seeds", async () => {
    const { root, repo, cleanup } = makeFixtureRepo();
    try {
      const wt1 = join(root, "wt-cow");
      const seedDir = join(root, ".cow-seeds", "default");
      let sawSeedLockDuringClone = false;
      const lockObservingExec: CowExec = (program, args) => {
        const src = args.at(-2);
        if (
          program !== "git" &&
          src &&
          src.startsWith(seedDir) &&
          existsSync(`${dirname(src)}.lock`)
        ) {
          sawSeedLockDuringClone = true;
        }
        return mockCopyExec(program, args);
      };

      const res1 = await createWorktreeWithCowFallback({
        cwd: repo,
        worktreePath: wt1,
        addArguments: ["-b", "feat/cow", "main"],
        seedDir,
        platform: "linux",
        exec: lockObservingExec,
        runPlainAdd: async () => {
          runGit(repo, ["worktree", "add", wt1, "-b", "feat/cow", "main"]);
        },
        runNoCheckoutAdd: async () => {
          runGit(repo, ["worktree", "add", "--no-checkout", wt1, "-b", "feat/cow", "main"]);
        },
      });
      expect(res1.mechanism).toBe("reflink");
      expect(res1.lockfileMatched).toBe(true);
      expect(sawSeedLockDuringClone).toBe(true);
      expect(existsSync(`${seedDir}.lock`)).toBe(false);
      expect(existsSync(join(wt1, "src", "index.ts"))).toBe(true);
      expect(existsSync(join(wt1, ".env.example"))).toBe(true);
      expect(existsSync(join(wt1, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(existsSync(join(wt1, ".env.local"))).toBe(false);
      expect(existsSync(join(wt1, ".claude"))).toBe(false);
      expect(runGit(wt1, ["status", "--porcelain"])).toBe("");

      writeFileSync(join(seedDir, "src", "index.ts"), "export const v = 999;\n");
      const wtDirty = join(root, "wt-dirty-seed");
      const resDirty = await createWorktreeWithCowFallback({
        cwd: repo,
        worktreePath: wtDirty,
        addArguments: ["-b", "feat/dirty", "main"],
        seedDir,
        platform: "linux",
        exec: mockCopyExec,
        runPlainAdd: async () => {
          runGit(repo, ["worktree", "add", wtDirty, "-b", "feat/dirty", "main"]);
        },
        runNoCheckoutAdd: async () => {
          runGit(repo, ["worktree", "add", "--no-checkout", wtDirty, "-b", "feat/dirty", "main"]);
        },
      });
      expect(resDirty.mechanism).toBe("plain");
      expect(resDirty.fallbackReason).toBe("seed-failed:dirty-seed");
      expect(readFileSync(join(wtDirty, "src", "index.ts"), "utf8")).toBe("export const v = 1;\n");
      expect(runGit(wtDirty, ["status", "--porcelain"])).toBe("");
    } finally {
      cleanup();
    }
  });

  it("rejects symlinked dependency roots and falls back cleanly when reflinks are unsupported", async () => {
    const { root, repo, cleanup } = makeFixtureRepo();
    try {
      const sharedModules = join(root, "shared-modules");
      renameSync(join(repo, "node_modules"), sharedModules);
      symlinkSync(sharedModules, join(repo, "node_modules"));

      const wtSym = join(root, "wt-symlink");
      const resSym = await createWorktreeWithCowFallback({
        cwd: repo,
        worktreePath: wtSym,
        addArguments: ["-b", "feat/sym", "main"],
        platform: "linux",
        exec: mockCopyExec,
        runPlainAdd: async () => {
          runGit(repo, ["worktree", "add", wtSym, "-b", "feat/sym", "main"]);
        },
        runNoCheckoutAdd: async () => {
          runGit(repo, ["worktree", "add", "--no-checkout", wtSym, "-b", "feat/sym", "main"]);
        },
      });
      expect(resSym.mechanism).toBe("reflink");
      expect(resSym.lockfileMatched).toBe(false);
      expect(existsSync(join(wtSym, "node_modules"))).toBe(false);

      const wtPlain = join(root, "wt-plain");
      const resPlain = await createWorktreeWithCowFallback({
        cwd: repo,
        worktreePath: wtPlain,
        addArguments: ["-b", "feat/plain", "main"],
        platform: "linux",
        exec: () => ({ status: 1, stdout: "", stderr: "Operation not supported", error: null }),
        runPlainAdd: async () => {
          runGit(repo, ["worktree", "add", wtPlain, "-b", "feat/plain", "main"]);
        },
        runNoCheckoutAdd: async () => {
          throw new Error("should not call no-checkout when reflink unsupported");
        },
      });
      expect(resPlain.mechanism).toBe("plain");
      expect(resPlain.fallbackReason).toBe("reflink-unsupported");
      expect(existsSync(join(wtPlain, "src", "index.ts"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
