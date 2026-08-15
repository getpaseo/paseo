import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PaseoConfigRaw } from "@getpaseo/protocol/paseo-config-schema";
import { hasUncommittedWorktreeSetupChanges } from "./worktree-setup-commit-status.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeGitRepo(config?: PaseoConfigRaw): string {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "worktree-setup-status-test-")));
  tempDirs.push(repoRoot);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  writeFileSync(join(repoRoot, "README.md"), "test\n");
  if (config) writeConfig(repoRoot, config);
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  return repoRoot;
}

function writeConfig(repoRoot: string, config: PaseoConfigRaw): void {
  writeFileSync(join(repoRoot, "paseo.json"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("worktree setup commit status", () => {
  test("reports matching committed setup as clean", async () => {
    const repoRoot = makeGitRepo({ worktree: { setup: "npm ci" } });
    await expect(
      hasUncommittedWorktreeSetupChanges({
        repoRoot,
        currentConfig: { worktree: { setup: "npm ci" } },
      }),
    ).resolves.toBe(false);
  });

  test("reports modified and staged setup as uncommitted", async () => {
    const repoRoot = makeGitRepo({ worktree: { setup: "npm ci" } });
    const currentConfig = { worktree: { setup: "npm install" } };
    writeConfig(repoRoot, currentConfig);
    await expect(hasUncommittedWorktreeSetupChanges({ repoRoot, currentConfig })).resolves.toBe(
      true,
    );

    execFileSync("git", ["add", "paseo.json"], { cwd: repoRoot });
    await expect(hasUncommittedWorktreeSetupChanges({ repoRoot, currentConfig })).resolves.toBe(
      true,
    );
  });

  test("reports an untracked config with setup as uncommitted", async () => {
    const repoRoot = makeGitRepo();
    const currentConfig = { worktree: { setup: "npm ci" } };
    writeConfig(repoRoot, currentConfig);
    await expect(hasUncommittedWorktreeSetupChanges({ repoRoot, currentConfig })).resolves.toBe(
      true,
    );
  });

  test("ignores representation-only and unrelated config changes", async () => {
    const repoRoot = makeGitRepo({
      worktree: { setup: "npm ci", teardown: "echo old" },
      scripts: { dev: { command: "npm run dev" } },
    });
    const currentConfig = {
      worktree: { setup: ["npm ci"], teardown: "echo new" },
      scripts: { dev: { command: "npm run start" } },
      metadataGeneration: { branchName: { instructions: "Use fix/" } },
    };
    writeConfig(repoRoot, currentConfig);
    await expect(hasUncommittedWorktreeSetupChanges({ repoRoot, currentConfig })).resolves.toBe(
      false,
    );
  });

  test("resolves paseo.json relative to a nested project root", async () => {
    const repoRoot = makeGitRepo();
    const projectRoot = join(repoRoot, "packages", "app");
    mkdirSync(projectRoot, { recursive: true });
    writeConfig(projectRoot, { worktree: { setup: "npm ci" } });
    execFileSync("git", ["add", "packages/app/paseo.json"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "add nested config"], { cwd: repoRoot });
    const currentConfig = { worktree: { setup: "npm install" } };
    writeConfig(projectRoot, currentConfig);
    await expect(
      hasUncommittedWorktreeSetupChanges({ repoRoot: projectRoot, currentConfig }),
    ).resolves.toBe(true);
  });
});
