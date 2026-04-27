import { execSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface TempRepo {
  path: string;
  branchHeads: Record<string, string>;
  cleanup: () => Promise<void>;
}

export const createTempGitRepo = async (
  prefix = "hubcode-e2e-",
  options?: {
    withRemote?: boolean;
    hubcodeConfig?: Record<string, unknown>;
    files?: Array<{ path: string; content: string }>;
    branches?: string[];
  },
): Promise<TempRepo> => {
  // Keep E2E repo paths short so terminal prompt + typed commands stay visible without zsh clipping.
  // Resolve symlinks (macOS: /tmp → /private/tmp) so paths match the daemon's resolved paths.
  const tempRoot = process.platform === "win32" ? tmpdir() : await realpath("/tmp");
  const repoPath = await mkdtemp(path.join(tempRoot, prefix));
  const withRemote = options?.withRemote ?? false;

  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.email "e2e@hubcode.test"', { cwd: repoPath, stdio: "ignore" });
  execSync('git config user.name "Hubcode E2E"', { cwd: repoPath, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "ignore" });
  await writeFile(path.join(repoPath, "README.md"), "# Temp Repo\n");
  if (options?.hubcodeConfig) {
    await writeFile(
      path.join(repoPath, "hubcode.json"),
      JSON.stringify(options.hubcodeConfig, null, 2),
    );
  }
  for (const file of options?.files ?? []) {
    const filePath = path.join(repoPath, file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
  }
  execSync("git add README.md", { cwd: repoPath, stdio: "ignore" });
  if (options?.hubcodeConfig) {
    execSync("git add hubcode.json", { cwd: repoPath, stdio: "ignore" });
  }
  for (const file of options?.files ?? []) {
    execSync(`git add ${JSON.stringify(file.path)}`, { cwd: repoPath, stdio: "ignore" });
  }
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: "ignore" });

  const branchHeads: Record<string, string> = {};
  const branches = Array.from(new Set(options?.branches ?? []));
  for (const branch of branches) {
    if (branch !== "main") {
      execSync(`git checkout -b ${JSON.stringify(branch)} main`, {
        cwd: repoPath,
        stdio: "ignore",
      });
    }
    const markerPath = `.hubcode-e2e-${branch.replace(/[^a-zA-Z0-9._-]/g, "-")}.txt`;
    await writeFile(path.join(repoPath, markerPath), `branch ${branch}\n`);
    execSync(`git add ${JSON.stringify(markerPath)}`, { cwd: repoPath, stdio: "ignore" });
    execSync(`git commit -m ${JSON.stringify(`Add ${branch} marker`)}`, {
      cwd: repoPath,
      stdio: "ignore",
    });
    branchHeads[branch] = execSync(`git rev-parse ${JSON.stringify(branch)}`, {
      cwd: repoPath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    execSync("git checkout main", { cwd: repoPath, stdio: "ignore" });
  }

  if (withRemote) {
    // Deterministic local remote to avoid relying on external auth/network in e2e.
    const remoteDir = path.join(repoPath, "remote.git");
    await mkdir(remoteDir, { recursive: true });
    execSync(`git init --bare -b main ${remoteDir}`, { cwd: repoPath, stdio: "ignore" });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoPath, stdio: "ignore" });
    execSync("git push -u origin --all", { cwd: repoPath, stdio: "ignore" });
  }

  return {
    path: repoPath,
    branchHeads,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
};

export async function readWorktreeBranchInfo({ worktreePath }: { worktreePath: string }): Promise<{
  currentBranch: string;
  hasAncestor: (ref: string) => boolean;
}> {
  const currentBranch = execSync("git branch --show-current", {
    cwd: worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  return {
    currentBranch,
    hasAncestor: (ref: string) => {
      try {
        execSync(`git merge-base --is-ancestor ${JSON.stringify(ref)} HEAD`, {
          cwd: worktreePath,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
