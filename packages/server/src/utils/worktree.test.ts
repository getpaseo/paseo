import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createWorktree,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
  getWorktreeTerminalSpecs,
  isPaseoOwnedWorktreeCwd,
  listPaseoWorktrees,
  resolveWorktreeRuntimeEnv,
  type WorktreeSetupCommandProgressEvent,
  runWorktreeSetupCommands,
  slugify,
} from "./worktree";
import { getPaseoWorktreeMetadataPath } from "./worktree-metadata.js";
import { execSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import net from "node:net";

describe.skipIf(process.platform === "win32")("createWorktree", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    // Create a git repo with an initial commit
    mkdirSync(repoDir, { recursive: true });
    execSync("git init -b main", { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    execSync('echo "hello" > file.txt', { cwd: repoDir });
    execSync("git add .", { cwd: repoDir });
    execSync('git -c commit.gpgsign=false commit -m "initial"', { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a worktree for the current branch (main)", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello-world",
      paseoHome,
    });

    expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "hello-world"));
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
    const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
  });

  it.skip("detects paseo-owned worktrees across realpath differences (macOS /var vs /private/var)", async () => {
    // Intentionally create repo using the non-realpath tmpdir() variant (often /var/... on macOS).
    const varTempDir = mkdtempSync(join(tmpdir(), "worktree-realpath-test-"));
    const privateTempDir = realpathSync(varTempDir);
    const varRepoDir = join(varTempDir, "test-repo");
    const varPaseoHome = join(varTempDir, "paseo-home");
    mkdirSync(varRepoDir, { recursive: true });
    execSync("git init -b main", { cwd: varRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: varRepoDir });
    execSync('git config user.name "Test"', { cwd: varRepoDir });
    execSync('echo "hello" > file.txt', { cwd: varRepoDir });
    execSync("git add .", { cwd: varRepoDir });
    execSync('git -c commit.gpgsign=false commit -m "initial"', { cwd: varRepoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: varRepoDir,
      baseBranch: "main",
      worktreeSlug: "realpath-test",
      paseoHome: varPaseoHome,
    });

    const projectHash = await deriveWorktreeProjectHash(varRepoDir);
    const privateWorktreePath = join(
      privateTempDir,
      "paseo-home",
      "worktrees",
      projectHash,
      "realpath-test",
    );
    expect(existsSync(privateWorktreePath)).toBe(true);

    const ownership = await isPaseoOwnedWorktreeCwd(privateWorktreePath, {
      paseoHome: varPaseoHome,
    });
    expect(ownership.allowed).toBe(true);

    rmSync(varTempDir, { recursive: true, force: true });
  });

  it("reports repoRoot as the repository root for paseo-owned worktrees", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "repo-root-check",
      paseoHome,
    });

    const ownership = await isPaseoOwnedWorktreeCwd(result.worktreePath, { paseoHome });
    expect(ownership.allowed).toBe(true);
    expect(ownership.repoRoot).toBe(repoDir);
  });

  it("treats non-git directories as non-worktrees without throwing", async () => {
    const nonGitDir = join(tempDir, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });

    const ownership = await isPaseoOwnedWorktreeCwd(nonGitDir, { paseoHome });

    expect(ownership.allowed).toBe(false);
    expect(ownership.worktreePath).toBe(realpathSync(nonGitDir));
  });

  it("creates a worktree with a new branch", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    const result = await createWorktree({
      branchName: "feature-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "my-feature",
      paseoHome,
    });

    expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "my-feature"));
    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify branch was created
    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("feature-branch");
    const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
  });

  it("prefers origin/{branch} over local {branch} when both exist", async () => {
    const remoteDir = join(tempDir, "remote.git");
    const remoteCloneDir = join(tempDir, "remote-clone");
    execSync(`git init --bare ${remoteDir}`);
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoDir });
    execSync("git push -u origin main", { cwd: repoDir });

    execSync(`git clone ${remoteDir} ${remoteCloneDir}`);
    execSync('git config user.email "test@test.com"', { cwd: remoteCloneDir });
    execSync('git config user.name "Test"', { cwd: remoteCloneDir });
    execSync("git checkout -B main origin/main", { cwd: remoteCloneDir });
    writeFileSync(join(remoteCloneDir, "file.txt"), "from-origin\n");
    execSync("git add file.txt", { cwd: remoteCloneDir });
    execSync('git -c commit.gpgsign=false commit -m "advance origin main"', {
      cwd: remoteCloneDir,
    });
    execSync("git push origin main", { cwd: remoteCloneDir });

    writeFileSync(join(repoDir, "file.txt"), "from-local\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync('git -c commit.gpgsign=false commit -m "advance local main"', { cwd: repoDir });

    execSync("git fetch origin", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "prefer-origin-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "prefer-origin-feature",
      runSetup: false,
      paseoHome,
    });

    expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-origin\n");
  });

  it("falls back to local {branch} when origin/{branch} does not exist", async () => {
    writeFileSync(join(repoDir, "file.txt"), "from-local-only\n");
    execSync("git add file.txt", { cwd: repoDir });
    execSync('git -c commit.gpgsign=false commit -m "advance local main only"', { cwd: repoDir });

    const result = await createWorktree({
      branchName: "prefer-local-fallback-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "prefer-local-fallback-feature",
      runSetup: false,
      paseoHome,
    });

    expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-local-only\n");
  });

  it("throws when neither origin/{branch} nor local {branch} exists", async () => {
    await expect(
      createWorktree({
        branchName: "missing-base-feature",
        cwd: repoDir,
        baseBranch: "does-not-exist",
        worktreeSlug: "missing-base-feature",
        runSetup: false,
        paseoHome,
      }),
    ).rejects.toThrow("Base branch not found: does-not-exist");
  });

  it("fails with invalid branch name", async () => {
    await expect(
      createWorktree({
        branchName: "INVALID_UPPERCASE",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "test",
      }),
    ).rejects.toThrow("Invalid branch name");
  });

  it("handles branch name collision by adding suffix", async () => {
    const projectHash = await deriveWorktreeProjectHash(repoDir);
    // Create a branch named "hello" first
    execSync("git branch hello", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello",
      paseoHome,
    });

    // Should create branch "hello-1" since "hello" exists
    expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "hello"));
    expect(existsSync(result.worktreePath)).toBe(true);

    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("hello-1");
  });

  it("handles multiple collisions", async () => {
    // Create branches "hello" and "hello-1"
    execSync("git branch hello", { cwd: repoDir });
    execSync("git branch hello-1", { cwd: repoDir });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "hello",
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);

    const branches = execSync("git branch", { cwd: repoDir }).toString();
    expect(branches).toContain("hello-2");
  });

  it("runs setup commands from paseo.json", async () => {
    // Create paseo.json with setup commands
    const paseoConfig = {
      worktree: {
        setup: [
          'echo "source=$PASEO_SOURCE_CHECKOUT_PATH" > setup.log',
          'echo "root_alias=$PASEO_ROOT_PATH" >> setup.log',
          'echo "worktree=$PASEO_WORKTREE_PATH" >> setup.log',
          'echo "branch=$PASEO_BRANCH_NAME" >> setup.log',
          'echo "port=$PASEO_WORKTREE_PORT" >> setup.log',
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync('git add paseo.json && git -c commit.gpgsign=false commit -m "add paseo.json"', {
      cwd: repoDir,
    });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "setup-test",
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);

    // Verify setup ran and env vars were available
    const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
    expect(setupLog).toContain(`source=${repoDir}`);
    expect(setupLog).toContain(`root_alias=${repoDir}`);
    expect(setupLog).toContain(`worktree=${result.worktreePath}`);
    expect(setupLog).toContain("branch=setup-test");
    const portLine = setupLog.split("\n").find((line) => line.startsWith("port="));
    expect(portLine).toBeDefined();
    const portValue = Number(portLine?.slice("port=".length));
    expect(Number.isInteger(portValue)).toBe(true);
    expect(portValue).toBeGreaterThan(0);
  });

  it("does not run setup commands when runSetup=false", async () => {
    const paseoConfig = {
      worktree: {
        setup: ['echo "setup ran" > setup.log'],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync('git add paseo.json && git -c commit.gpgsign=false commit -m "add paseo.json"', {
      cwd: repoDir,
    });

    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "no-setup-test",
      runSetup: false,
      paseoHome,
    });

    expect(existsSync(result.worktreePath)).toBe(true);
    expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
  });

  it("streams setup command progress events while commands are executing", async () => {
    const paseoConfig = {
      worktree: {
        setup: ['echo "first line"; echo "second line" 1>&2'],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync('git add paseo.json && git -c commit.gpgsign=false commit -m "add streaming setup"', {
      cwd: repoDir,
    });

    const progressEvents: WorktreeSetupCommandProgressEvent[] = [];
    const results = await runWorktreeSetupCommands({
      worktreePath: repoDir,
      branchName: "main",
      cleanupOnFailure: false,
      onEvent: (event) => {
        progressEvents.push(event);
      },
    });

    expect(results).toHaveLength(1);
    expect(progressEvents.some((event) => event.type === "command_started")).toBe(true);
    expect(progressEvents.some((event) => event.type === "output")).toBe(true);
    expect(progressEvents.some((event) => event.type === "command_completed")).toBe(true);
  });

  it("reuses persisted worktree runtime port across resolutions", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "runtime-env-port-reuse",
      runSetup: false,
      paseoHome,
    });

    const first = await resolveWorktreeRuntimeEnv({
      worktreePath: result.worktreePath,
      branchName: result.branchName,
    });
    const second = await resolveWorktreeRuntimeEnv({
      worktreePath: result.worktreePath,
      branchName: result.branchName,
    });

    expect(second.PASEO_WORKTREE_PORT).toBe(first.PASEO_WORKTREE_PORT);
  });

  it("fails runtime env resolution when persisted port is in use", async () => {
    const result = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "runtime-env-port-conflict",
      runSetup: false,
      paseoHome,
    });

    const env = await resolveWorktreeRuntimeEnv({
      worktreePath: result.worktreePath,
      branchName: result.branchName,
    });
    const port = Number(env.PASEO_WORKTREE_PORT);

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });

    await expect(
      resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      }),
    ).rejects.toThrow(`Persisted worktree port ${port} is already in use`);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("cleans up worktree if setup command fails", async () => {
    // Create paseo.json with failing setup command
    const paseoConfig = {
      worktree: {
        setup: ["exit 1"],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync('git add paseo.json && git -c commit.gpgsign=false commit -m "add paseo.json"', {
      cwd: repoDir,
    });

    const expectedWorktreePath = join(paseoHome, "worktrees", "test-repo", "fail-test");

    await expect(
      createWorktree({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "fail-test",
        paseoHome,
      }),
    ).rejects.toThrow("Worktree setup command failed");

    // Verify worktree was cleaned up
    expect(existsSync(expectedWorktreePath)).toBe(false);
  });

  it("reads worktree terminal specs from paseo.json with optional name", async () => {
    const paseoConfig = {
      worktree: {
        terminals: [
          { name: "Dev Server", command: "npm run dev" },
          { command: "cd packages/app && npm run dev" },
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));

    expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
      { name: "Dev Server", command: "npm run dev" },
      { command: "cd packages/app && npm run dev" },
    ]);
  });

  it("filters invalid worktree terminal specs", async () => {
    const paseoConfig = {
      worktree: {
        terminals: [
          null,
          {},
          { name: "   ", command: "   " },
          { name: " Watch ", command: "npm run watch", cwd: "packages/app" },
          { name: 123, command: "npm run test" },
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));

    expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
      { name: "Watch", command: "npm run watch" },
      { command: "npm run test" },
    ]);
  });
});

describe("paseo worktree manager", () => {
  let tempDir: string;
  let repoDir: string;
  let paseoHome: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
    repoDir = join(tempDir, "test-repo");
    paseoHome = join(tempDir, "paseo-home");

    mkdirSync(repoDir, { recursive: true });
    execSync("git init -b main", { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    execSync('echo "hello" > file.txt', { cwd: repoDir });
    execSync("git add .", { cwd: repoDir });
    execSync('git -c commit.gpgsign=false commit -m "initial"', { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("isolates worktree roots for repositories that share the same directory name", async () => {
    const repoA = join(tempDir, "team-a", "test-repo");
    const repoB = join(tempDir, "team-b", "test-repo");

    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execSync("git init -b main", { cwd: repo });
      execSync('git config user.email "test@test.com"', { cwd: repo });
      execSync('git config user.name "Test"', { cwd: repo });
      execSync('echo "hello" > file.txt', { cwd: repo });
      execSync("git add .", { cwd: repo });
      execSync('git -c commit.gpgsign=false commit -m "initial"', { cwd: repo });
    }

    const fromRepoA = await createWorktree({
      branchName: "main",
      cwd: repoA,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });
    const fromRepoB = await createWorktree({
      branchName: "main",
      cwd: repoB,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });

    expect(dirname(fromRepoA.worktreePath)).not.toBe(dirname(fromRepoB.worktreePath));
    expect(fromRepoA.worktreePath.endsWith("alpha-1")).toBe(false);
    expect(fromRepoB.worktreePath.endsWith("alpha-1")).toBe(false);

    const repoAWorktrees = await listPaseoWorktrees({ cwd: repoA, paseoHome });
    const repoBWorktrees = await listPaseoWorktrees({ cwd: repoB, paseoHome });

    expect(repoAWorktrees.map((entry) => entry.path)).toEqual([fromRepoA.worktreePath]);
    expect(repoBWorktrees.map((entry) => entry.path)).toEqual([fromRepoB.worktreePath]);
  });

  it("lists and deletes paseo worktrees under ~/.paseo/worktrees/{hash}", async () => {
    const first = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });
    const second = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "beta",
      paseoHome,
    });

    const worktrees = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    const paths = worktrees.map((worktree) => worktree.path).sort();
    expect(paths).toEqual([first.worktreePath, second.worktreePath].sort());

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: first.worktreePath, paseoHome });
    expect(existsSync(first.worktreePath)).toBe(false);

    const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    expect(remaining.map((worktree) => worktree.path)).toEqual([second.worktreePath]);
  });

  it("deletes a paseo worktree even when given a subdirectory path", async () => {
    const created = await createWorktree({
      branchName: "main",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "alpha",
      paseoHome,
    });

    const nestedDir = join(created.worktreePath, "nested", "dir");
    mkdirSync(nestedDir, { recursive: true });

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: nestedDir, paseoHome });
    expect(existsSync(created.worktreePath)).toBe(false);

    const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
    expect(remaining.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
  });

  it("runs teardown commands from paseo.json before deleting a worktree", async () => {
    const paseoConfig = {
      worktree: {
        teardown: [
          'echo "source=$PASEO_SOURCE_CHECKOUT_PATH" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
          'echo "root_alias=$PASEO_ROOT_PATH" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
          'echo "worktree=$PASEO_WORKTREE_PATH" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
          'echo "branch=$PASEO_BRANCH_NAME" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
          'echo "port=$PASEO_WORKTREE_PORT" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync(
      'git add paseo.json && git -c commit.gpgsign=false commit -m "add teardown commands"',
      {
        cwd: repoDir,
      },
    );

    const created = await createWorktree({
      branchName: "teardown-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "teardown-test",
      paseoHome,
    });
    const runtimeEnv = await resolveWorktreeRuntimeEnv({
      worktreePath: created.worktreePath,
      branchName: created.branchName,
    });

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome });
    expect(existsSync(created.worktreePath)).toBe(false);

    const teardownLog = readFileSync(join(repoDir, "teardown.log"), "utf8");
    expect(teardownLog).toContain(`source=${repoDir}`);
    expect(teardownLog).toContain(`root_alias=${repoDir}`);
    expect(teardownLog).toContain(`worktree=${created.worktreePath}`);
    expect(teardownLog).toContain("branch=teardown-branch");
    expect(teardownLog).toContain(`port=${runtimeEnv.PASEO_WORKTREE_PORT}`);
  });

  it("omits PASEO_WORKTREE_PORT from teardown env when runtime metadata is missing", async () => {
    const paseoConfig = {
      worktree: {
        teardown: [
          'echo "port=${PASEO_WORKTREE_PORT-unset}" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-port.log"',
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync(
      'git add paseo.json && git -c commit.gpgsign=false commit -m "add teardown port logging"',
      { cwd: repoDir },
    );

    const created = await createWorktree({
      branchName: "teardown-port-missing-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "teardown-port-missing-test",
      paseoHome,
    });

    await deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome });

    expect(readFileSync(join(repoDir, "teardown-port.log"), "utf8").trim()).toBe("port=unset");
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("does not remove worktree when a teardown command fails", async () => {
    const paseoConfig = {
      worktree: {
        teardown: [
          'echo "started" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-start.log"',
          "echo boom 1>&2; exit 9",
        ],
      },
    };
    writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
    execSync(
      'git add paseo.json && git -c commit.gpgsign=false commit -m "add failing teardown commands"',
      { cwd: repoDir },
    );

    const created = await createWorktree({
      branchName: "teardown-failure-branch",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "teardown-failure-test",
      paseoHome,
    });

    await expect(
      deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
    ).rejects.toThrow("Worktree teardown command failed");

    expect(existsSync(created.worktreePath)).toBe(true);
    expect(existsSync(join(repoDir, "teardown-start.log"))).toBe(true);
  });
});

describe("slugify", () => {
  it("converts to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("FOO_BAR")).toBe("foo-bar");
  });

  it("truncates long strings at word boundary", () => {
    const longInput =
      "https-stackoverflow-com-questions-68349031-only-run-actions-on-non-draft-pull-request";
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toBe("https-stackoverflow-com-questions-68349031-only");
  });

  it("truncates without trailing hyphen when no word boundary", () => {
    const longInput = "a".repeat(60);
    const result = slugify(longInput);
    expect(result.length).toBe(50);
    expect(result.endsWith("-")).toBe(false);
  });
});
