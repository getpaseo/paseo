import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorktreePathScriptArgv,
  buildWorktreePathScriptEnv,
  deriveWorktreeRepoHash,
  resolveWorktreePathFromScript,
  validateWorktreeScriptPath,
  type WorktreePathScriptContext,
} from "./worktree-path-script.js";

describe("worktree-path-script", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const tempDir = mkdtempSync(join(tmpdir(), "worktree-path-script-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  function makeContext(repoPath: string): WorktreePathScriptContext {
    return {
      repoPath,
      repo: "repo",
      owner: "",
      remoteRepo: "",
      branchName: "feature/x",
      slug: "feature-x",
      repoHash: deriveWorktreeRepoHash(repoPath),
      mode: "branch-off",
      baseRef: "",
      paseoHome: join(repoPath, "..", "paseo-home"),
    };
  }

  function writeScript(tempDir: string, body: string): string {
    const scriptPath = join(tempDir, "place");
    writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it("builds argv in the fixed contract order and mirrors it in env", () => {
    const context = makeContext("/repos/widgets");
    expect(buildWorktreePathScriptArgv(context)).toEqual([
      "/repos/widgets",
      "repo",
      "",
      "",
      "feature/x",
      "feature-x",
      context.repoHash,
      "branch-off",
      "",
      join("/repos", "paseo-home"),
    ]);
    const env = buildWorktreePathScriptEnv(context);
    expect(env.PASEO_REPO_PATH).toBe("/repos/widgets");
    expect(env.PASEO_OWNER).toBe("");
    expect(env.PASEO_BASE_REF).toBe("");
    expect(env.PASEO_BRANCH_NAME).toBe("feature/x");
    expect(env.PASEO_WORKTREE_SLUG).toBe("feature-x");
  });

  it("passes all 10 values to the script as argv and env, in the script's cwd", async () => {
    const tempDir = makeTempDir();
    const repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    const target = join(tempDir, "placed", "feature-x");
    const script = writeScript(
      tempDir,
      [
        `printf '%s' "$PWD" > "${join(tempDir, "cwd")}"`,
        `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "\${10}" > "${join(tempDir, "argv")}"`,
        `printf '%s|%s|%s' "$PASEO_BRANCH_NAME" "$PASEO_WORKTREE_MODE" "$PASEO_BASE_REF" > "${join(tempDir, "env")}"`,
        `printf '%s\\n' '${target}'`,
      ].join("\n"),
    );
    const context = {
      ...makeContext(repoPath),
      owner: "acme",
      remoteRepo: "widgets",
      baseRef: "main",
    };

    const result = await resolveWorktreePathFromScript({ script, context });

    expect(result).toBe(target);
    expect(readFileSync(join(tempDir, "cwd"), "utf8")).toBe(repoPath);
    expect(readFileSync(join(tempDir, "argv"), "utf8")).toBe(
      [
        repoPath,
        "repo",
        "acme",
        "widgets",
        "feature/x",
        "feature-x",
        context.repoHash,
        "branch-off",
        "main",
        context.paseoHome,
      ].join("|"),
    );
    expect(readFileSync(join(tempDir, "env"), "utf8")).toBe("feature/x|branch-off|main");
    // The script must not have created the path; Paseo creates it later.
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a relative script path as a config error", async () => {
    const context = makeContext(makeTempDir());
    await expect(resolveWorktreePathFromScript({ script: "bin/place", context })).rejects.toThrow(
      "worktrees.pathScript must be an absolute path",
    );
  });

  it("fails with the script's stderr on non-zero exit", async () => {
    const tempDir = makeTempDir();
    const script = writeScript(tempDir, "echo 'no space left' >&2\nexit 3");
    await expect(
      resolveWorktreePathFromScript({ script, context: makeContext(tempDir) }),
    ).rejects.toThrow(/exited with code 3: no space left/);
  });

  it("rejects empty and multi-line stdout", async () => {
    const tempDir = makeTempDir();
    const repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    const empty = writeScript(tempDir, "exit 0");
    await expect(
      resolveWorktreePathFromScript({ script: empty, context: makeContext(repoPath) }),
    ).rejects.toThrow("printed nothing");
    const noisy = writeScript(tempDir, `printf 'log line\\n%s\\n' '${join(tempDir, "x")}'`);
    await expect(
      resolveWorktreePathFromScript({ script: noisy, context: makeContext(repoPath) }),
    ).rejects.toThrow("more than one line");
  });

  it("rejects relative output and denylisted destinations", async () => {
    const tempDir = makeTempDir();
    const repoPath = join(tempDir, "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });

    expect(() => validateWorktreeScriptPath({ candidate: "relative/path", repoPath })).toThrow(
      "relative path",
    );
    expect(() => validateWorktreeScriptPath({ candidate: repoPath, repoPath })).toThrow(
      "repository root itself",
    );
    expect(() =>
      validateWorktreeScriptPath({ candidate: join(repoPath, ".git", "wt"), repoPath }),
    ).toThrow("inside a .git directory");
    expect(() => validateWorktreeScriptPath({ candidate: tempDir, repoPath })).toThrow(
      "ancestor of the repository",
    );
  });

  it("rejects an existing path and hints the script must not create it", async () => {
    const tempDir = makeTempDir();
    const repoPath = join(tempDir, "repo");
    const existing = join(tempDir, "already-there");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(existing, { recursive: true });
    const script = writeScript(tempDir, `mkdir -p '${existing}'\nprintf '%s\\n' '${existing}'`);
    await expect(
      resolveWorktreePathFromScript({ script, context: makeContext(repoPath) }),
    ).rejects.toThrow(/already exists|not a git worktree/);
  });
});
