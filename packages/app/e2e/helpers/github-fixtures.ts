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

export interface IssueSpec {
  title: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
}

export interface GhPrFixture {
  number: number;
  title: string;
  url: string;
  branch: string;
  localPath: string;
}

export interface GhIssueFixture {
  number: number;
  title: string;
  url: string;
}

export interface GhRepoFixture {
  owner: string;
  name: string;
  fullName: string;
  prs: GhPrFixture[];
  issues: GhIssueFixture[];
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

async function seedPr(args: {
  spec: PrSpec;
  branch: string;
  index: number;
  basePath: string;
  authedUrl: string;
  fullName: string;
  repoName: string;
}): Promise<{ fixture: GhPrFixture; localPath: string }> {
  const { spec, branch, index, basePath, authedUrl, fullName, repoName } = args;

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

  for (let j = 0; j < (spec.commentCount ?? 0); j++) {
    gh(["pr", "comment", String(prNumber), "--body", `Test comment ${j + 1}`], { cwd: basePath });
  }

  if (spec.state === "merged") {
    gh(["pr", "merge", String(prNumber), "--merge"], { cwd: basePath });
  } else if (spec.state === "closed") {
    gh(["pr", "close", String(prNumber)], { cwd: basePath });
  }

  const localPath = await mkdtemp(path.join("/tmp", `${repoName}-ws-${index}-`));
  git(["clone", authedUrl, localPath, "--quiet", "-b", branch], basePath);
  // Clean remote URL (no embedded token) so gh can parse owner/repo
  git(["remote", "set-url", "origin", `https://github.com/${fullName}.git`], localPath);
  git(["config", "user.email", "e2e@paseo.test"], localPath);
  git(["config", "user.name", "Paseo E2E"], localPath);
  git(["config", "commit.gpgsign", "false"], localPath);

  return {
    fixture: { number: prNumber, title: spec.title, url: prUrl, branch, localPath },
    localPath,
  };
}

function seedIssue(args: { spec: IssueSpec; basePath: string }): GhIssueFixture {
  const { spec, basePath } = args;
  const createArgs = ["issue", "create", "--title", spec.title, "--body", spec.body ?? ""];
  for (const label of spec.labels ?? []) {
    createArgs.push("--label", label);
  }
  const issueUrl = gh(createArgs, { cwd: basePath });
  const issueNumber = parseInt(issueUrl.split("/").pop() ?? "0", 10);
  if (spec.state === "closed") {
    gh(["issue", "close", String(issueNumber)], { cwd: basePath });
  }
  return { number: issueNumber, title: spec.title, url: issueUrl };
}

// Single namespace for temporary GitHub repos created by Paseo tests.
// Bulk cleanup relies on this prefix being unmistakable — never reuse `paseo-`
// (collides with real repos like `paseo`, `paseo-website`).
const TEMP_GITHUB_REPO_PREFIX = "paseotmp-";

export async function createTempGithubRepo(options: {
  category: string;
  prs?: PrSpec[];
  issues?: IssueSpec[];
}): Promise<GhRepoFixture> {
  const { category, prs = [], issues = [] } = options;
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const repoName = `${TEMP_GITHUB_REPO_PREFIX}${category}-${uniqueSuffix}`;

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

  if (branches.length > 0) {
    git(["push", "origin", ...branches], basePath);
  }

  // Create PRs, seed checks/comments, apply state changes, clone workspaces
  const prFixtures: GhPrFixture[] = [];
  const localPaths: string[] = [];

  for (let i = 0; i < prs.length; i++) {
    const { fixture, localPath } = await seedPr({
      spec: prs[i],
      branch: branches[i],
      index: i,
      basePath,
      authedUrl,
      fullName,
      repoName,
    });
    localPaths.push(localPath);
    prFixtures.push(fixture);
  }

  // Create issues
  const issueFixtures: GhIssueFixture[] = [];
  for (const spec of issues) {
    issueFixtures.push(seedIssue({ spec, basePath }));
  }

  return {
    owner,
    name: repoName,
    fullName,
    prs: prFixtures,
    issues: issueFixtures,
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
