import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  computeGithubNextInterval,
  createGitHubService,
  resolveGitHubRepo,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
  type GitHubCurrentPullRequestStatus,
  type GitHubReadOptions,
} from "./github-service.js";
import { CheckoutPrStatusResponseSchema } from "../shared/messages.js";

const EXPECTED_GITHUB_FAST_POLL_MS = 20_000;
const EXPECTED_GITHUB_SLOW_POLL_MS = 120_000;
const EXPECTED_GITHUB_ERROR_BACKOFF_CAP_MS = 300_000;

interface RunnerCall {
  args: string[];
  cwd: string;
}

interface TestRunner {
  calls: RunnerCall[];
  runner: GitHubCommandRunner;
  resolveNext: (stdout: string) => void;
}

type RunnerStep =
  | string
  | {
      stdout?: string;
      stderr?: string;
      error?: Error;
    };

function createRunner(stdoutByCall: string[]): TestRunner {
  const calls: RunnerCall[] = [];

  return {
    calls,
    runner: async (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd });
      const stdout = stdoutByCall.shift() ?? "[]";
      return { stdout, stderr: "" };
    },
    resolveNext: () => {},
  };
}

function createScriptedRunner(steps: RunnerStep[]): TestRunner {
  const calls: RunnerCall[] = [];

  return {
    calls,
    runner: async (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd });
      const step = steps.shift() ?? "";
      if (typeof step === "string") {
        return { stdout: step, stderr: "" };
      }
      if (step.error) {
        throw step.error;
      }
      return { stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
    },
    resolveNext: () => {},
  };
}

function createDeferredRunner(): TestRunner {
  const calls: RunnerCall[] = [];
  let resolveNext: ((stdout: string) => void) | null = null;

  return {
    calls,
    runner: (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd });
      return new Promise((resolve) => {
        resolveNext = (stdout: string) => resolve({ stdout, stderr: "" });
      });
    },
    resolveNext: (stdout: string) => {
      if (!resolveNext) {
        throw new Error("No runner call is waiting for resolution.");
      }
      resolveNext(stdout);
    },
  };
}

function currentPullRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    url: "https://github.com/parentOwner/parentRepo/pull/42",
    title: "Fork PR",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/fork",
    mergedAt: null,
    statusCheckRollup: [],
    reviewDecision: "REVIEW_REQUIRED",
    ...overrides,
  });
}

function createCurrentPullRequestStatus(
  overrides: Partial<GitHubCurrentPullRequestStatus> = {},
): GitHubCurrentPullRequestStatus {
  return {
    number: 42,
    repoOwner: "acme",
    repoName: "repo",
    url: "https://github.com/acme/repo/pull/42",
    title: "Update feature",
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: false,
    isDraft: false,
    checks: [],
    checksStatus: "none",
    reviewDecision: null,
    ...overrides,
  };
}

function recordCurrentPullRequestStatusReads(service: ReturnType<typeof createGitHubService>) {
  const reads: GitHubReadOptions[] = [];
  const getCurrentPullRequestStatus = service.getCurrentPullRequestStatus.bind(service);
  service.getCurrentPullRequestStatus = vi.fn(async (options) => {
    reads.push(options);
    return getCurrentPullRequestStatus(options);
  });
  return reads;
}

function noPullRequestError(args: string[] = ["pr", "view"]): GitHubCommandError {
  return new GitHubCommandError({
    args,
    cwd: "/repo",
    exitCode: 1,
    stderr: "no pull requests found for branch",
  });
}

function pullRequestJson(title: string): string {
  return JSON.stringify([
    {
      number: 123,
      title,
      url: "https://github.com/acme/repo/pull/123",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature",
      labels: [{ name: "bug" }],
    },
  ]);
}

function pullRequestCheckoutTargetJson(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 526,
          baseRefName: "main",
          headRefName: "main",
          isCrossRepository: true,
          headRepositoryOwner: { login: "therainisme" },
          headRepository: {
            sshUrl: "git@github.com:therainisme/paseo.git",
            url: "https://github.com/therainisme/paseo",
          },
        },
      },
    },
  });
}

function repoViewJson(): string {
  return JSON.stringify({
    owner: { login: "getpaseo" },
    name: "paseo",
    parent: null,
  });
}

function issueJson(title: string): string {
  return JSON.stringify([
    {
      number: 55,
      title,
      url: "https://github.com/acme/repo/issues/55",
      state: "OPEN",
      body: "issue body",
      labels: [{ name: "bug" }],
      updatedAt: "2026-04-18T12:00:00Z",
    },
  ]);
}

function searchPullRequestJson(title: string): string {
  return JSON.stringify([
    {
      number: 123,
      title,
      url: "https://github.com/acme/repo/pull/123",
      state: "OPEN",
      body: "pr body",
      baseRefName: "main",
      headRefName: "feature",
      labels: [{ name: "enhancement" }],
      updatedAt: "2026-04-18T13:00:00Z",
    },
  ]);
}

function pullRequestTimelineJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 42,
          reviews: {
            nodes: [
              {
                id: "PRR_approved",
                state: "APPROVED",
                body: "Looks good to me.",
                url: "https://github.com/parentOwner/parentRepo/pull/42#pullrequestreview-1",
                submittedAt: "2026-04-02T13:52:14Z",
                author: {
                  login: "reviewer",
                  url: "https://github.com/reviewer",
                },
              },
              {
                id: "PRR_empty_commented",
                state: "COMMENTED",
                body: "",
                url: "https://github.com/parentOwner/parentRepo/pull/42#pullrequestreview-2",
                submittedAt: "2026-04-02T13:50:00Z",
                author: null,
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          comments: {
            nodes: [
              {
                id: "IC_later",
                body: "Can we add a regression test?",
                url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-3",
                createdAt: "2026-04-02T13:55:00Z",
                author: {
                  login: "commenter",
                  url: "https://github.com/commenter",
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          ...overrides,
        },
      },
    },
  });
}

describe("GitHubService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes fast cadence for pending and slow cadence for stable PR states", () => {
    const pendingStatus = createCurrentPullRequestStatus({ checksStatus: "pending" });
    const runningCheckStatus = createCurrentPullRequestStatus({
      checksStatus: "success",
      checks: [{ name: "ci", status: "pending", url: null }],
    });
    const stableStatus = createCurrentPullRequestStatus({ checksStatus: "success" });

    expect(computeGithubNextInterval(pendingStatus, 0)).toBe(EXPECTED_GITHUB_FAST_POLL_MS);
    expect(computeGithubNextInterval(runningCheckStatus, 0)).toBe(EXPECTED_GITHUB_FAST_POLL_MS);
    expect(computeGithubNextInterval(stableStatus, 0)).toBe(EXPECTED_GITHUB_SLOW_POLL_MS);
    expect(computeGithubNextInterval(null, 0)).toBe(EXPECTED_GITHUB_SLOW_POLL_MS);
  });

  it("computes exponential error backoff up to the cap", () => {
    const stableStatus = createCurrentPullRequestStatus({ checksStatus: "success" });

    expect(computeGithubNextInterval(stableStatus, 1)).toBe(EXPECTED_GITHUB_SLOW_POLL_MS);
    expect(computeGithubNextInterval(stableStatus, 2)).toBe(240_000);
    expect(computeGithubNextInterval(stableStatus, 3)).toBe(EXPECTED_GITHUB_ERROR_BACKOFF_CAP_MS);
    expect(computeGithubNextInterval(stableStatus, 4)).toBe(EXPECTED_GITHUB_ERROR_BACKOFF_CAP_MS);
  });

  it("loads pull request checkout target details through GraphQL", async () => {
    const runner = createRunner([repoViewJson(), pullRequestCheckoutTargetJson()]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getPullRequestCheckoutTarget?.({ cwd: "/repo", number: 526 }),
    ).resolves.toEqual({
      number: 526,
      baseRefName: "main",
      headRefName: "main",
      headOwnerLogin: "therainisme",
      headRepositorySshUrl: "git@github.com:therainisme/paseo.git",
      headRepositoryUrl: "https://github.com/therainisme/paseo",
      isCrossRepository: true,
    });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toEqual({
      cwd: "/repo",
      args: ["repo", "view", "--json", "owner,name,parent"],
    });
    expect(runner.calls[1]?.cwd).toBe("/repo");
    expect(runner.calls[1]?.args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(runner.calls[1]?.args).toContain("owner=getpaseo");
    expect(runner.calls[1]?.args).toContain("name=paseo");
    expect(runner.calls[1]?.args).toContain("number=526");
  });

  it("polls PR status at fast cadence while checks are pending", async () => {
    let now = 0;
    const runner = createRunner([
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
      }),
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });
    const reads = recordCurrentPullRequestStatusReads(service);

    const subscription = service.retainCurrentPullRequestStatusPoll?.({
      cwd: "/repo",
      headRef: "feature/fork",
    });
    await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });

    now = EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);

    expect(runner.calls).toHaveLength(2);
    expect(reads.map((read) => read.reason)).toEqual([undefined, "self-heal-github"]);

    subscription?.unsubscribe();
    service.dispose?.();
  });

  it("polls PR status at slow cadence after stable checks", async () => {
    let now = 0;
    const runner = createRunner([
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });
    const reads = recordCurrentPullRequestStatusReads(service);

    const subscription = service.retainCurrentPullRequestStatusPoll?.({
      cwd: "/repo",
      headRef: "feature/fork",
    });
    await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });

    now = EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);
    expect(runner.calls).toHaveLength(1);

    now = EXPECTED_GITHUB_SLOW_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_SLOW_POLL_MS - EXPECTED_GITHUB_FAST_POLL_MS);
    expect(runner.calls).toHaveLength(2);
    expect(reads.map((read) => read.reason)).toEqual([undefined, "self-heal-github"]);

    subscription?.unsubscribe();
    service.dispose?.();
  });

  it("backs off consecutive poll errors and resets cadence after recovery", async () => {
    let now = 0;
    const runner = createScriptedRunner([
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
      }),
      { error: new Error("network down") },
      { error: new Error("network still down") },
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });
    const reads = recordCurrentPullRequestStatusReads(service);

    const subscription = service.retainCurrentPullRequestStatusPoll?.({
      cwd: "/repo",
      headRef: "feature/fork",
    });
    await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });

    now = EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);
    now += EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);
    now += EXPECTED_GITHUB_FAST_POLL_MS * 2;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS * 2);
    now += EXPECTED_GITHUB_SLOW_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_SLOW_POLL_MS);

    expect(runner.calls).toHaveLength(5);
    expect(reads.map((read) => read.reason)).toEqual([
      undefined,
      "self-heal-github",
      "self-heal-github",
      "self-heal-github",
      "self-heal-github",
    ]);

    subscription?.unsubscribe();
    service.dispose?.();
  });

  it("unsubscribe clears the adaptive GitHub poll timer", async () => {
    let now = 0;
    const runner = createRunner([
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });

    const subscription = service.retainCurrentPullRequestStatusPoll?.({
      cwd: "/repo",
      headRef: "feature/fork",
    });
    await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    subscription?.unsubscribe();

    now = EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);

    expect(runner.calls).toHaveLength(1);

    service.dispose?.();
  });

  it("dispose clears all adaptive GitHub poll timers", async () => {
    let now = 0;
    const runner = createRunner([
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }],
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });

    service.retainCurrentPullRequestStatusPoll?.({ cwd: "/repo", headRef: "feature/fork" });
    await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    service.dispose?.();

    now = EXPECTED_GITHUB_FAST_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_FAST_POLL_MS);

    expect(runner.calls).toHaveLength(1);
  });

  it("fetches PR reviews and issue comments with one GraphQL call sorted chronologically", async () => {
    const runner = createRunner([pullRequestTimelineJson()]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      cwd: "/repo",
      args: [
        "api",
        "graphql",
        "-f",
        expect.stringContaining("query="),
        "-F",
        "owner=parentOwner",
        "-F",
        "name=parentRepo",
        "-F",
        "number=42",
      ],
    });
    expect(runner.calls[0]?.args[3]).toContain("reviews(first: 100)");
    expect(runner.calls[0]?.args[3]).toContain("comments(first: 100)");
    expect(timeline).toEqual({
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
      truncated: false,
      error: null,
      items: [
        {
          kind: "review",
          id: "PRR_empty_commented",
          author: "unknown",
          authorUrl: null,
          body: "",
          createdAt: Date.parse("2026-04-02T13:50:00Z"),
          url: "https://github.com/parentOwner/parentRepo/pull/42#pullrequestreview-2",
          reviewState: "commented",
        },
        {
          kind: "review",
          id: "PRR_approved",
          author: "reviewer",
          authorUrl: "https://github.com/reviewer",
          body: "Looks good to me.",
          createdAt: Date.parse("2026-04-02T13:52:14Z"),
          url: "https://github.com/parentOwner/parentRepo/pull/42#pullrequestreview-1",
          reviewState: "approved",
        },
        {
          kind: "comment",
          id: "IC_later",
          author: "commenter",
          authorUrl: "https://github.com/commenter",
          body: "Can we add a regression test?",
          createdAt: Date.parse("2026-04-02T13:55:00Z"),
          url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-3",
        },
      ],
    });
  });

  it("uses the passed parent repository identity for fork PR timelines", async () => {
    const runner = createRunner([pullRequestTimelineJson()]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await service.getPullRequestTimeline({
      cwd: "/local/fork",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(runner.calls[0]?.args).toEqual([
      "api",
      "graphql",
      "-f",
      expect.stringContaining("repository(owner: $owner, name: $name)"),
      "-F",
      "owner=parentOwner",
      "-F",
      "name=parentRepo",
      "-F",
      "number=42",
    ]);
  });

  it("marks PR timeline results truncated when reviews or comments hit the pagination cap", async () => {
    const runner = createRunner([
      pullRequestTimelineJson({
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: true },
        },
        comments: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline).toMatchObject({
      items: [],
      truncated: true,
      error: null,
    });
  });

  it("maps PR timeline GraphQL access failures to typed internal errors", async () => {
    const runner = createScriptedRunner([
      {
        error: new GitHubCommandError({
          args: ["api", "graphql"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "GraphQL: Resource not accessible by integration",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline).toEqual({
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
      items: [],
      truncated: false,
      error: {
        kind: "forbidden",
        message: "GraphQL: Resource not accessible by integration",
      },
    });
  });

  it("maps PR timeline missing PR failures to typed internal errors", async () => {
    const runner = createScriptedRunner([
      {
        error: new GitHubCommandError({
          args: ["api", "graphql"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "GraphQL: Could not resolve to a PullRequest",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 404,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toEqual({
      kind: "not_found",
      message: "GraphQL: Could not resolve to a PullRequest",
    });
  });

  it("does not classify unrelated not found failures as missing PR timeline errors", async () => {
    const runner = createScriptedRunner([
      {
        error: new GitHubCommandError({
          args: ["api", "graphql"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "fatal: remote not found",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toEqual({
      kind: "unknown",
      message: "fatal: remote not found",
    });
  });

  it("maps a missing gh binary during PR timeline fetch to an unknown timeline error", async () => {
    const runner = createRunner([]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => null,
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(runner.calls).toHaveLength(0);
    expect(timeline.error).toEqual({
      kind: "unknown",
      message: "GitHub CLI (gh) is not installed or not in PATH",
    });
  });

  it("maps PR timeline authentication failures to forbidden timeline errors", async () => {
    const runner = createScriptedRunner([
      {
        error: new GitHubCommandError({
          args: ["api", "graphql"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "To authenticate, run: gh auth login",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toEqual({
      kind: "forbidden",
      message: "To authenticate, run: gh auth login",
    });
  });

  it("maps PR timeline rate limits to unknown timeline errors", async () => {
    const runner = createScriptedRunner([
      {
        error: new GitHubCommandError({
          args: ["api", "graphql"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "GraphQL: API rate limit exceeded for user ID 123",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toEqual({
      kind: "unknown",
      message: "GraphQL: API rate limit exceeded for user ID 123",
    });
  });

  it("maps PR timeline network timeouts to unknown timeline errors with runner details", async () => {
    const runner = createScriptedRunner([
      {
        error: Object.assign(new Error("request timed out after 10000ms"), {
          code: "ETIMEDOUT",
        }),
      },
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toEqual({
      kind: "unknown",
      message: "request timed out after 10000ms",
    });
  });

  it("maps PR timeline JSON parse failures to unknown timeline errors", async () => {
    const runner = createRunner(["{"]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    });

    expect(timeline.error).toMatchObject({
      kind: "unknown",
    });
    expect(timeline.error?.message).toContain("JSON");
  });

  it("caches PR timelines by cwd and PR number until invalidated", async () => {
    const runner = createRunner([
      pullRequestTimelineJson({
        comments: {
          nodes: [
            {
              id: "IC_first",
              body: "First cached result",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-1",
              createdAt: "2026-04-02T13:55:00Z",
              author: { login: "commenter", url: "https://github.com/commenter" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
      pullRequestTimelineJson({
        comments: {
          nodes: [
            {
              id: "IC_refreshed",
              body: "Refreshed result",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-2",
              createdAt: "2026-04-02T13:56:00Z",
              author: { login: "commenter", url: "https://github.com/commenter" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });
    const request = {
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    };

    const first = await service.getPullRequestTimeline(request);
    const second = await service.getPullRequestTimeline(request);
    service.invalidate({ cwd: "/repo" });
    const refreshed = await service.getPullRequestTimeline(request);

    expect(first.items.at(-1)?.body).toBe("First cached result");
    expect(second.items.at(-1)?.body).toBe("First cached result");
    expect(refreshed.items.at(-1)?.body).toBe("Refreshed result");
    expect(runner.calls).toHaveLength(2);
  });

  it("does not cache a PR timeline result that resolves after cwd invalidation", async () => {
    const runner = createDeferredRunner();
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });
    const request = {
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    };

    const staleRequest = service.getPullRequestTimeline(request);
    await Promise.resolve();
    expect(runner.calls).toHaveLength(1);

    service.invalidate({ cwd: "/repo" });
    runner.resolveNext(
      pullRequestTimelineJson({
        comments: {
          nodes: [
            {
              id: "IC_stale",
              body: "Stale pre-invalidation result",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-1",
              createdAt: "2026-04-02T13:55:00Z",
              author: { login: "commenter", url: "https://github.com/commenter" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    );
    const stale = await staleRequest;
    expect(stale.items.at(-1)?.body).toBe("Stale pre-invalidation result");

    const freshRequest = service.getPullRequestTimeline(request);
    await Promise.resolve();
    expect(runner.calls).toHaveLength(2);
    runner.resolveNext(
      pullRequestTimelineJson({
        comments: {
          nodes: [
            {
              id: "IC_fresh",
              body: "Fresh post-invalidation result",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-2",
              createdAt: "2026-04-02T13:56:00Z",
              author: { login: "commenter", url: "https://github.com/commenter" },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }),
    );

    const fresh = await freshRequest;
    expect(fresh.items.at(-1)?.body).toBe("Fresh post-invalidation result");
    expect(runner.calls).toHaveLength(2);
  });

  it("requests and surfaces current PR number, draft state, workflow names, and formatted check durations", async () => {
    const runner = createRunner([
      JSON.stringify({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "Wire real PR pane data",
        state: "OPEN",
        isDraft: true,
        baseRefName: "main",
        headRefName: "feature/pr-pane",
        mergedAt: null,
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            completedAt: "2026-04-02T13:52:14Z",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/acme/repo/actions/runs/123",
            name: "server-tests",
            startedAt: "2026-04-02T13:50:00Z",
            status: "COMPLETED",
            workflowName: "Server CI",
            checkSuite: {
              workflowRun: {
                databaseId: 123,
              },
            },
          },
          {
            __typename: "StatusContext",
            context: "deploy/preview",
            state: "SUCCESS",
            targetUrl: "https://github.com/acme/repo/status/preview",
            createdAt: "2026-04-02T13:51:00Z",
          },
        ],
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/pr-pane",
    });

    expect(runner.calls[0]?.args).toEqual([
      "pr",
      "view",
      "--json",
      "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
    ]);
    expect(status).toEqual({
      number: 42,
      repoOwner: "acme",
      repoName: "repo",
      url: "https://github.com/acme/repo/pull/42",
      title: "Wire real PR pane data",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/pr-pane",
      isMerged: false,
      isDraft: true,
      checks: [
        {
          name: "server-tests",
          status: "success",
          url: "https://github.com/acme/repo/actions/runs/123",
          workflow: "Server CI",
          duration: "2m 14s",
        },
        {
          name: "deploy/preview",
          status: "success",
          url: "https://github.com/acme/repo/status/preview",
        },
      ],
      checksStatus: "success",
      reviewDecision: "pending",
    });
  });

  it("resolves fork PR heads to the parent repository when gh pr view returns a stale branch match", async () => {
    const runner = createScriptedRunner([
      currentPullRequestJson({
        number: 7,
        url: "https://github.com/parentOwner/parentRepo/pull/7",
        title: "Stale tracking PR",
        headRefName: "old-branch",
      }),
      JSON.stringify({
        owner: { login: "forkOwner" },
        name: "parentRepo",
        parent: { owner: { login: "parentOwner" }, name: "parentRepo" },
      }),
      JSON.stringify([
        {
          number: 41,
          url: "https://github.com/parentOwner/parentRepo/pull/41",
          title: "Wrong fork owner",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/fork",
          mergedAt: null,
          statusCheckRollup: [],
          reviewDecision: "REVIEW_REQUIRED",
          headRepositoryOwner: { login: "otherFork" },
        },
        {
          number: 42,
          url: "https://github.com/parentOwner/parentRepo/pull/42",
          title: "Real fork PR",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/fork",
          mergedAt: null,
          statusCheckRollup: [],
          reviewDecision: "REVIEW_REQUIRED",
          headRepositoryOwner: { login: "forkOwner" },
        },
      ]),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
    });

    expect(status).toMatchObject({
      number: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
      title: "Real fork PR",
      headRefName: "feature/fork",
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "pr",
        "view",
        "--json",
        "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
      ],
      ["repo", "view", "--json", "owner,name,parent"],
      [
        "pr",
        "list",
        "--repo",
        "parentOwner/parentRepo",
        "--state",
        "all",
        "--head",
        "forkOwner:feature/fork",
        "--json",
        "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
        "--limit",
        "10",
      ],
    ]);
  });

  it("does not match another fork owner's PR when the current branch is main", async () => {
    const calls: RunnerCall[] = [];
    const runner: GitHubCommandRunner = async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args[0] === "pr" && args[1] === "view") {
        throw noPullRequestError(args);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
        return {
          stdout: JSON.stringify([
            {
              number: 77,
              url: "https://github.com/parentOwner/parentRepo/pull/77",
              title: "Unrelated fork main branch",
              state: "OPEN",
              isDraft: false,
              baseRefName: "main",
              headRefName: "main",
              mergedAt: null,
              statusCheckRollup: [],
              reviewDecision: "REVIEW_REQUIRED",
              headRepositoryOwner: { login: "otherForkOwner" },
            },
          ]),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          owner: { login: "repoOwner" },
          name: "repo",
          parent: null,
        }),
        stderr: "",
      };
    };
    const service = createGitHubService({
      runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "main",
      }),
    ).resolves.toBeNull();
    expect(calls.map((call) => call.args)).toEqual([
      [
        "pr",
        "view",
        "--json",
        "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
      ],
      ["repo", "view", "--json", "owner,name,parent"],
    ]);
  });

  it("selects the requested fork owner when resolving a scoped PR worktree branch", async () => {
    const runner = createScriptedRunner([
      { error: noPullRequestError() },
      JSON.stringify([
        {
          number: 77,
          url: "https://github.com/repoOwner/repo/pull/77",
          title: "Unrelated fork main branch",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "main",
          mergedAt: null,
          statusCheckRollup: [],
          reviewDecision: "REVIEW_REQUIRED",
          headRepositoryOwner: { login: "otherForkOwner" },
        },
        {
          number: 345,
          url: "https://github.com/repoOwner/repo/pull/345",
          title: "Requested fork main branch",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "main",
          mergedAt: null,
          statusCheckRollup: [],
          reviewDecision: "REVIEW_REQUIRED",
          headRepositoryOwner: { login: "chethanuk" },
        },
      ]),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "main",
      headRepositoryOwner: "chethanuk",
    });

    expect(status).toMatchObject({
      number: 345,
      repoOwner: "repoOwner",
      repoName: "repo",
      headRefName: "main",
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "pr",
        "view",
        "--json",
        "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
      ],
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "main",
        "--json",
        "number,url,title,state,isDraft,baseRefName,headRefName,mergedAt,statusCheckRollup,reviewDecision,headRepositoryOwner",
        "--limit",
        "10",
      ],
    ]);
  });

  it("finds a fork PR in the parent repo when the direct current branch view is unavailable", async () => {
    const runner = createScriptedRunner([
      { error: noPullRequestError() },
      JSON.stringify({
        owner: { login: "forkOwner" },
        name: "repo",
        parent: { owner: { login: "parentOwner" }, name: "repo" },
      }),
      JSON.stringify([
        {
          number: 88,
          url: "https://github.com/parentOwner/repo/pull/88",
          title: "Fork-only PR",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/fork",
          mergedAt: null,
          statusCheckRollup: [],
          reviewDecision: null,
          headRepositoryOwner: { login: "forkOwner" },
        },
      ]),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
    });

    expect(status).toMatchObject({
      number: 88,
      repoOwner: "parentOwner",
      repoName: "repo",
      headRefName: "feature/fork",
    });
    expect(runner.calls[2]?.args).toContain("forkOwner:feature/fork");
  });

  it("propagates DNS errors while resolving the current PR view", async () => {
    const dnsError = new GitHubCommandError({
      args: ["pr", "view"],
      cwd: "/repo",
      exitCode: 1,
      stderr: "could not resolve host: github.com",
    });
    const runner = createScriptedRunner([{ error: dnsError }]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/pr-pane",
      }),
    ).rejects.toBe(dnsError);
  });

  it("returns null when no current branch PR is matched by view or qualified fork lookup", async () => {
    const runner = createScriptedRunner([
      { error: noPullRequestError() },
      JSON.stringify({
        owner: { login: "forkOwner" },
        name: "repo",
        parent: { owner: { login: "parentOwner" }, name: "repo" },
      }),
      "[]",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/missing",
      }),
    ).resolves.toBeNull();
  });

  it("keeps S1 PR status schema additions optional and strips internal check timestamps", () => {
    const oldDaemonResponse = CheckoutPrStatusResponseSchema.parse({
      type: "checkout_pr_status_response",
      payload: {
        cwd: "/repo",
        status: {
          url: "https://github.com/acme/repo/pull/42",
          title: "Old daemon payload",
          state: "open",
          baseRefName: "main",
          headRefName: "feature",
          isMerged: false,
        },
        githubFeaturesEnabled: true,
        error: null,
        requestId: "req-old",
      },
    });
    expect(oldDaemonResponse.payload.status).toMatchObject({
      isDraft: false,
      checks: [],
    });

    const newDaemonResponse = CheckoutPrStatusResponseSchema.parse({
      type: "checkout_pr_status_response",
      payload: {
        cwd: "/repo",
        status: {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "New daemon payload",
          state: "open",
          baseRefName: "main",
          headRefName: "feature",
          isMerged: false,
          isDraft: true,
          checks: [
            {
              name: "server-tests",
              status: "success",
              url: "https://github.com/acme/repo/actions/runs/123",
              workflow: "Server CI",
              duration: "2m 14s",
              startedAt: "2026-04-02T13:50:00Z",
              completedAt: "2026-04-02T13:52:14Z",
              workflowRunDatabaseId: 123,
            },
          ],
          checksStatus: "success",
          reviewDecision: "pending",
        },
        githubFeaturesEnabled: true,
        error: null,
        requestId: "req-new",
      },
    });

    expect(newDaemonResponse.payload.status).toEqual({
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "New daemon payload",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      isDraft: true,
      checks: [
        {
          name: "server-tests",
          status: "success",
          url: "https://github.com/acme/repo/actions/runs/123",
          workflow: "Server CI",
          duration: "2m 14s",
        },
      ],
      checksStatus: "success",
      reviewDecision: "pending",
    });
  });

  it("returns cached results for identical calls within the TTL", async () => {
    const runner = createRunner([pullRequestJson("First result")]);
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    const second = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });

    expect(first).toEqual(second);
    expect(first[0]?.title).toBe("First result");
    expect(runner.calls).toHaveLength(1);
  });

  it("refreshes cached results after the TTL expires", async () => {
    let now = 100;
    const runner = createRunner([
      pullRequestJson("First result"),
      pullRequestJson("Second result"),
    ]);
    const service = createGitHubService({
      ttlMs: 50,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });

    const first = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    now = 151;
    const second = await service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });

    expect(first[0]?.title).toBe("First result");
    expect(second[0]?.title).toBe("Second result");
    expect(runner.calls).toHaveLength(2);
  });

  it("coalesces concurrent identical calls into one runner invocation", async () => {
    const runner = createDeferredRunner();
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    const second = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    await Promise.resolve();
    runner.resolveNext(pullRequestJson("Shared result"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          number: 123,
          title: "Shared result",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: null,
          baseRefName: "main",
          headRefName: "feature",
          labels: ["bug"],
          updatedAt: "",
        },
      ],
      [
        {
          number: 123,
          title: "Shared result",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: null,
          baseRefName: "main",
          headRefName: "feature",
          labels: ["bug"],
          updatedAt: "",
        },
      ],
    ]);
    expect(runner.calls).toHaveLength(1);
  });

  it("invalidates only cache entries matching the requested cwd", async () => {
    const runner = createRunner([
      pullRequestJson("Repo one"),
      pullRequestJson("Repo two"),
      pullRequestJson("Repo one refreshed"),
    ]);
    const service = createGitHubService({
      ttlMs: 1_000,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await service.listPullRequests({ cwd: "/repo-one", query: "bug", limit: 10 });
    await service.listPullRequests({ cwd: "/repo-two", query: "bug", limit: 10 });
    service.invalidate({ cwd: "/repo-one" });
    const refreshed = await service.listPullRequests({ cwd: "/repo-one", query: "bug", limit: 10 });
    const cached = await service.listPullRequests({ cwd: "/repo-two", query: "bug", limit: 10 });

    expect(refreshed[0]?.title).toBe("Repo one refreshed");
    expect(cached[0]?.title).toBe("Repo two");
    expect(runner.calls).toHaveLength(3);
  });

  it("throws a typed missing-cli error when gh is unavailable", async () => {
    const runner = createRunner([]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => null,
      now: () => 100,
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toBeInstanceOf(
      GitHubCliMissingError,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("throws a typed auth error for authentication failures", async () => {
    const service = createGitHubService({
      runner: async () => {
        throw new GitHubCommandError({
          args: ["auth", "status"],
          cwd: "/repo",
          exitCode: 1,
          stderr: "To authenticate, run: gh auth login",
        });
      },
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(service.isAuthenticated({ cwd: "/repo" })).rejects.toBeInstanceOf(
      GitHubAuthenticationError,
    );
  });

  it("throws a typed command error for non-zero exits", async () => {
    const service = createGitHubService({
      runner: async () => {
        throw new GitHubCommandError({
          args: ["pr", "list"],
          cwd: "/repo",
          exitCode: 2,
          stderr: "GraphQL: unavailable",
        });
      },
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toMatchObject({
      kind: "command-error",
      exitCode: 2,
      stderr: "GraphQL: unavailable",
    });
  });

  it("searches GitHub issues and PRs", async () => {
    const runner = createRunner([issueJson("Issue title"), searchPullRequestJson("PR title")]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.searchIssuesAndPrs({ cwd: "/repo", query: "cache", limit: 5 }),
    ).resolves.toEqual({
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "pr",
          number: 123,
          title: "PR title",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: "pr body",
          labels: ["enhancement"],
          baseRefName: "main",
          headRefName: "feature",
          updatedAt: "2026-04-18T13:00:00Z",
        },
        {
          kind: "issue",
          number: 55,
          title: "Issue title",
          url: "https://github.com/acme/repo/issues/55",
          state: "OPEN",
          body: "issue body",
          labels: ["bug"],
          baseRefName: null,
          headRefName: null,
          updatedAt: "2026-04-18T12:00:00Z",
        },
      ],
    });

    expect(runner.calls).toEqual([
      {
        cwd: "/repo",
        args: [
          "issue",
          "list",
          "--search",
          "cache",
          "--json",
          "number,title,url,state,body,labels,updatedAt",
          "--limit",
          "5",
        ],
      },
      {
        cwd: "/repo",
        args: [
          "pr",
          "list",
          "--search",
          "cache",
          "--json",
          "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
          "--limit",
          "5",
        ],
      },
    ]);
  });

  it("searches only GitHub PRs when the search kinds request excludes issues", async () => {
    const runner = createRunner([searchPullRequestJson("PR title")]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.searchIssuesAndPrs({
        cwd: "/repo",
        query: "cache",
        limit: 5,
        kinds: ["github-pr"],
      }),
    ).resolves.toEqual({
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "pr",
          number: 123,
          title: "PR title",
          url: "https://github.com/acme/repo/pull/123",
          state: "OPEN",
          body: "pr body",
          labels: ["enhancement"],
          baseRefName: "main",
          headRefName: "feature",
          updatedAt: "2026-04-18T13:00:00Z",
        },
      ],
    });

    expect(runner.calls).toEqual([
      {
        cwd: "/repo",
        args: [
          "pr",
          "list",
          "--search",
          "cache",
          "--json",
          "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
          "--limit",
          "5",
        ],
      },
    ]);
  });

  it("reuses cached PR status without another gh call", async () => {
    let now = 100;
    const runner = createRunner([currentPullRequestJson()]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => now,
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" }),
    ).resolves.toMatchObject({ number: 42 });

    now = 101;
    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" }),
    ).resolves.toMatchObject({ number: 42 });

    expect(runner.calls).toHaveLength(1);
  });

  it("bypasses the warm PR status cache for forced reads", async () => {
    const runner = createRunner([
      currentPullRequestJson({ number: 41, title: "First" }),
      currentPullRequestJson({ number: 42, title: "Forced" }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" }),
    ).resolves.toMatchObject({ number: 41 });
    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/fork",
        force: true,
        reason: "test",
      }),
    ).resolves.toMatchObject({ number: 42 });

    expect(runner.calls).toHaveLength(2);
  });

  it("coalesces concurrent PR status callers", async () => {
    const runner = createDeferredRunner();
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    const second = service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    await Promise.resolve();

    expect(runner.calls).toHaveLength(1);
    runner.resolveNext(currentPullRequestJson());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ number: 42 }),
      expect.objectContaining({ number: 42 }),
    ]);
  });

  it("requires a reason for forced reads at runtime", async () => {
    const service = createGitHubService({
      runner: async () => ({ stdout: currentPullRequestJson(), stderr: "" }),
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/fork",
        force: true,
      } as never),
    ).rejects.toThrow("GitHubService forced read requires a reason");
  });

  it("type: force true requires a reason", () => {
    // @ts-expect-error force: true requires reason
    const invalid: GitHubReadOptions = { force: true };
    const valid: GitHubReadOptions = { force: true, reason: "test" };

    expect(invalid.force).toBe(true);
    expect(valid.reason).toBe("test");
  });

  it("resolves GitHub repos from the origin remote URL", async () => {
    vi.useRealTimers();
    const cwd = mkdtempSync(join(tmpdir(), "github-service-repo-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:getpaseo/paseo.git"], {
        cwd,
        stdio: "ignore",
      });

      await expect(resolveGitHubRepo(cwd)).resolves.toBe("getpaseo/paseo");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
