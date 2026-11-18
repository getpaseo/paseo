import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createTempGithubRepoName } from "../../test-utils/temp-github-repo.js";

const execute = promisify(execFile);

interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string; ref: string };
}

export async function githubWatchFixture(root: string) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
  const gh = async (...args: string[]) => {
    const result = await execute("gh", args, { env, timeout: 30_000 });
    return result.stdout;
  };
  async function api<T>(endpoint: string, ...args: string[]): Promise<T> {
    return JSON.parse(await gh("api", "--hostname", "github.com", endpoint, ...args)) as T;
  }

  const repoName = createTempGithubRepoName("change-request-watch");
  const repository = await api<{ full_name: string }>(
    "user/repos",
    "-X",
    "POST",
    "-f",
    `name=${repoName}`,
    "-F",
    "private=true",
    "-F",
    "auto_init=true",
  );
  const { full_name: slug } = repository;
  const repo = `repos/${slug}`;
  console.info(`GitHub watch fixture: ${slug}`);
  const close = () => gh("repo", "delete", `github.com/${slug}`, "--yes");

  try {
    const details = await api<{ default_branch: string }>(repo);
    const base = details.default_branch;

    async function branch(name: string, sha: string) {
      await api(`${repo}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${sha}`);
    }

    async function change(branchName: string, file: string, content: string, blobSha?: string) {
      const result = await api<{ commit: { sha: string } }>(
        `${repo}/contents/${file}`,
        "-X",
        "PUT",
        "-f",
        `branch=${branchName}`,
        "-f",
        "message=Add QA fixture",
        "-f",
        `content=${Buffer.from(content).toString("base64")}`,
        ...(blobSha ? ["-f", `sha=${blobSha}`] : []),
      );
      return result.commit.sha;
    }

    async function pull(branchName: string) {
      return api<PullRequest>(
        `${repo}/pulls`,
        "-f",
        `base=${base}`,
        "-f",
        `head=${branchName}`,
        "-f",
        `title=PR watch QA ${branchName}`,
        "-f",
        "body=Temporary private end-to-end fixture.",
        "-F",
        "draft=true",
      );
    }

    async function createPullRequests(count: number) {
      await change(base, ".coderabbit.yaml", "reviews:\n  auto_review:\n    enabled: false\n");
      const baseSha = await change(
        base,
        ".github/workflows/qa-watch.yml",
        [
          "name: QA watch",
          "on:",
          "  push:",
          "    branches: [events]",
          "jobs:",
          "  qa-check:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v6",
          '      - run: test "$(cat watch.txt)" = green',
        ].join("\n"),
      );
      await branch("events", baseSha);
      await change("events", "watch.txt", "red\n");
      const primary = await pull("events");
      await branch("quiet-1", baseSha);
      const quietHead = await change("quiet-1", "quiet.txt", "quiet\n");
      const quiet: PullRequest[] = [];
      for (let index = 1; index < count; index++) {
        const name = `quiet-${index}`;
        if (index > 1) await branch(name, quietHead);
        quiet.push(await pull(name));
      }
      return { primary, quiet };
    }

    async function updateCheck(pr: PullRequest, state: "red" | "green") {
      const file = await api<{ sha: string }>(`${repo}/contents/watch.txt?ref=${pr.head.ref}`);
      const sha = await change(pr.head.ref, "watch.txt", `${state}\n`, file.sha);
      return { ...pr, head: { ...pr.head, sha } };
    }

    async function checkConclusion(pr: PullRequest) {
      const checks = await api<{ check_runs: { name: string; conclusion: string | null }[] }>(
        `${repo}/commits/${pr.head.sha}/check-runs`,
      );
      return checks.check_runs.find((check) => check.name === "qa-check")?.conclusion;
    }

    async function comment(pr: PullRequest, body: string) {
      const result = await api<{ html_url: string }>(
        `${repo}/issues/${pr.number}/comments`,
        "-f",
        `body=${body}`,
      );
      return result.html_url;
    }

    async function seedComments(pr: PullRequest, count: number) {
      const { comments: existing } = await api<{ comments: number }>(`${repo}/pulls/${pr.number}`);
      const urls: string[] = [];
      for (let index = existing + 1; index <= count; index++) {
        urls.push(await comment(pr, `qa-page-comment-${String(index).padStart(3, "0")}`));
        // GitHub applies a separate per-minute limit to content creation.
        await delay(1_000);
      }
      return urls;
    }

    async function review(pr: PullRequest, body: string, inline: string) {
      const input = path.join(root, "review.json");
      await writeFile(
        input,
        JSON.stringify({
          event: "COMMENT",
          body,
          commit_id: pr.head.sha,
          comments: [{ path: "watch.txt", position: 1, body: inline }],
        }),
      );
      const submitted = await api<{ id: number; html_url: string }>(
        `${repo}/pulls/${pr.number}/reviews`,
        "--input",
        input,
      );
      const [inlineComment] = await api<{ html_url: string }[]>(
        `${repo}/pulls/${pr.number}/reviews/${submitted.id}/comments`,
      );
      if (!inlineComment) throw new Error("GitHub did not create the inline review comment");
      return { review: submitted.html_url, inline: inlineComment.html_url };
    }

    async function closePull(pr: PullRequest) {
      await api(`${repo}/pulls/${pr.number}`, "-X", "PATCH", "-f", "state=closed");
    }

    const checkout = (destination: string, ref: string) =>
      execute(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "clone",
          "--branch",
          ref,
          `https://github.com/${slug}.git`,
          destination,
        ],
        { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000 },
      );

    const switchToBase = (cwd: string) =>
      execute("git", ["switch", base], { cwd, timeout: 30_000 });

    async function limits() {
      const {
        resources: { core, graphql },
      } = await api<{
        resources: Record<"core" | "graphql", { used: number; remaining: number; reset: number }>;
      }>("rate_limit");
      return { core, graphql };
    }

    return {
      createPullRequests,
      updateCheck,
      checkConclusion,
      comment,
      seedComments,
      review,
      closePull,
      close,
      checkout,
      switchToBase,
      limits,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
