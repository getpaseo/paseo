import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function hasGithubAuth(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CheckSpec {
  context: string;
  state: "success" | "failure" | "pending";
}

export interface PrSpec {
  title: string;
  state: "open" | "merged" | "closed" | "draft";
  checks?: CheckSpec[];
  commentCount?: number;
}

export interface GhPrFixture {
  number: number;
  title: string;
  url: string;
  branch: string;
  localPath: string;
}

export interface GhRepoFixture {
  owner: string;
  name: string;
  fullName: string;
  prs: GhPrFixture[];
  cleanup(): Promise<void>;
}

function gh(args: string[], opts?: { cwd?: string }): string {
  return execFileSync("gh", args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function createTempGithubRepo(options: {
  prefix?: string;
  prs: PrSpec[];
}): Promise<GhRepoFixture> {
  const { prefix = "paseo-e2e-", prs } = options;
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repoName = `${prefix}${uniqueSuffix}`;

  // Bootstrap local git repo
  const basePath = await mkdtemp(path.join("/tmp", `${repoName}-base-`));
  git(["init", "-b", "main"], basePath);
  git(["config", "user.email", "e2e@paseo.test"], basePath);
  git(["config", "user.name", "Paseo E2E"], basePath);
  git(["config", "commit.gpgsign", "false"], basePath);
  await writeFile(path.join(basePath, "README.md"), "# E2E Test Repo\n");
  git(["add", "README.md"], basePath);
  git(["commit", "-m", "Initial commit"], basePath);

  // Create GitHub repo and push initial commit
  gh(["repo", "create", repoName, "--private", `--source=${basePath}`, "--push"]);

  const owner = gh(["api", "user", "--jq", ".login"]);
  const fullName = `${owner}/${repoName}`;
  const token = gh(["auth", "token"]);
  const authedUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;

  // Switch remote to authed URL for subsequent pushes
  git(["remote", "set-url", "origin", authedUrl], basePath);

  // Create a branch + commit for each PR spec
  const branches: string[] = [];
  for (let i = 0; i < prs.length; i++) {
    const branch = `pr-branch-${i + 1}`;
    branches.push(branch);
    git(["checkout", "-b", branch], basePath);
    await writeFile(path.join(basePath, `pr-${i + 1}.txt`), `PR ${i + 1}\n`);
    git(["add", `pr-${i + 1}.txt`], basePath);
    git(["commit", "-m", `Add PR ${i + 1}`], basePath);
    git(["checkout", "main"], basePath);
  }

  // Push all branches in one shot
  git(["push", "origin", ...branches], basePath);

  // Create PRs, seed checks/comments, apply state changes, clone workspace
  const prFixtures: GhPrFixture[] = [];
  const localPaths: string[] = [];

  for (let i = 0; i < prs.length; i++) {
    const spec = prs[i];
    const branch = branches[i];

    const createArgs = [
      "pr",
      "create",
      "--title",
      spec.title,
      "--base",
      "main",
      "--head",
      branch,
      "--body",
      "",
    ];
    if (spec.state === "draft") createArgs.push("--draft");

    const prUrl = gh(createArgs, { cwd: basePath });
    const prNumber = parseInt(prUrl.split("/").pop() ?? "0", 10);

    // Commit statuses for check pills
    if (spec.checks && spec.checks.length > 0) {
      const sha = git(["rev-parse", branch], basePath);
      for (const check of spec.checks) {
        gh([
          "api",
          `repos/${fullName}/statuses/${sha}`,
          "--method",
          "POST",
          "-f",
          `state=${check.state}`,
          "-f",
          `context=${check.context}`,
          "-f",
          `target_url=https://example.com/${encodeURIComponent(check.context)}`,
        ]);
      }
    }

    // PR comments for activity rows
    if (spec.commentCount && spec.commentCount > 0) {
      for (let j = 0; j < spec.commentCount; j++) {
        gh(["pr", "comment", String(prNumber), "--body", `Test comment ${j + 1}`], {
          cwd: basePath,
        });
      }
    }

    // Apply PR state
    if (spec.state === "merged") {
      gh(["pr", "merge", String(prNumber), "--merge"], { cwd: basePath });
    } else if (spec.state === "closed") {
      gh(["pr", "close", String(prNumber)], { cwd: basePath });
    }

    // Clone to a fresh workspace dir on the right branch
    const localPath = await mkdtemp(path.join("/tmp", `${repoName}-ws-${i}-`));
    git(["clone", authedUrl, localPath, "--quiet", "-b", branch], basePath);
    // Store a clean remote URL (no embedded token) so gh can parse it
    git(["remote", "set-url", "origin", `https://github.com/${fullName}.git`], localPath);
    git(["config", "user.email", "e2e@paseo.test"], localPath);
    git(["config", "user.name", "Paseo E2E"], localPath);
    git(["config", "commit.gpgsign", "false"], localPath);

    localPaths.push(localPath);
    prFixtures.push({ number: prNumber, title: spec.title, url: prUrl, branch, localPath });
  }

  return {
    owner,
    name: repoName,
    fullName,
    prs: prFixtures,
    cleanup: async () => {
      try {
        gh(["repo", "delete", fullName, "--yes"]);
      } catch {
        // Best-effort cleanup
      }
      await Promise.all([
        rm(basePath, { recursive: true, force: true }),
        ...localPaths.map((p) => rm(p, { recursive: true, force: true })),
      ]);
    },
  };
}
