import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  computeGithubNextInterval,
  createGitHubService,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
  type CurrentPullRequestStatus,
  type GitHubPullRequestStatusFacts,
} from "./github-service.js";
import { isPlatform } from "../test-utils/platform.js";
import { CheckoutPrStatusResponseSchema } from "@getpaseo/protocol/messages";

const EXPECTED_GITHUB_FAST_POLL_MS = 20_000;
const EXPECTED_GITHUB_SLOW_POLL_MS = 120_000;
const EXPECTED_GITHUB_ERROR_BACKOFF_CAP_MS = 300_000;
const CURRENT_PR_STATUS_BASE_FIELDS =
  "number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt,reviewDecision,mergeable,headRepositoryOwner";
const CURRENT_PR_STATUS_FIELDS = `${CURRENT_PR_STATUS_BASE_FIELDS},statusCheckRollup`;

interface RunnerCall {
  args: string[];
  cwd: string;
  envOverlay?: Record<string, string>;
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
      calls.push({ args, cwd: options.cwd, envOverlay: options.envOverlay });
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
      calls.push({ args, cwd: options.cwd, envOverlay: options.envOverlay });
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function createDeferredRunner(): TestRunner {
  const calls: RunnerCall[] = [];
  let resolveNext: ((stdout: string) => void) | null = null;

  return {
    calls,
    runner: (args: string[], options: GitHubCommandRunnerOptions) => {
      calls.push({ args, cwd: options.cwd, envOverlay: options.envOverlay });
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

interface FakeGitHubCliFixture {
  cwd: string;
  logPath: string;
  dispose: () => void;
}

function createFakeGitHubCliFixture(input: {
  remoteUrl: string;
  authStatusSucceeds?: boolean;
  authStatusMode?: "success" | "unauthenticated" | "transient-once";
}): FakeGitHubCliFixture {
  const previousPath = process.env.PATH;
  const previousLog = process.env.GH_TEST_LOG;
  const tempDir = mkdtempSync(join(tmpdir(), "github-service-gh-host-"));
  const repoDir = join(tempDir, "repo");
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "gh.log");
  const authStatusMode =
    input.authStatusMode ?? (input.authStatusSucceeds === true ? "success" : "unauthenticated");
  const authStatusStatePath = join(tempDir, "auth-status-state");
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "remote", "add", "origin", input.remoteUrl], {
    stdio: "pipe",
  });
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
AUTH_STATUS_MODE=${JSON.stringify(authStatusMode)}
AUTH_STATUS_STATE=${JSON.stringify(authStatusStatePath)}
printf '%s|%s\\n' "$*" "\${GH_HOST:-}" >> "$GH_TEST_LOG"
if [ "$1" = "--version" ]; then
  echo "gh version test"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--hostname" ]; then
  case "$AUTH_STATUS_MODE" in
    success)
      exit 0
      ;;
    transient-once)
      if [ ! -f "$AUTH_STATUS_STATE" ]; then
        touch "$AUTH_STATUS_STATE"
        echo "request timed out" >&2
        exit 2
      fi
      exit 0
      ;;
    *)
      echo "gh auth login required" >&2
      exit 1
      ;;
  esac
fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"owner":{"login":"acme"},"name":"repo"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  echo '{"url":"https://github.acme.internal/acme/repo/pull/7","number":7}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
  );
  chmodSync(ghPath, 0o755);
  process.env.PATH = [binDir, previousPath].filter(Boolean).join(delimiter);
  process.env.GH_TEST_LOG = logPath;
  return {
    cwd: repoDir,
    logPath,
    dispose: () => {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousLog === undefined) {
        delete process.env.GH_TEST_LOG;
      } else {
        process.env.GH_TEST_LOG = previousLog;
      }
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readFakeGitHubCliLog(logPath: string): string[] {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
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
    headRefOid: "1111111111111111111111111111111111111111",
    mergedAt: null,
    statusCheckRollup: [],
    reviewDecision: "REVIEW_REQUIRED",
    ...overrides,
  });
}

function currentPullRequestGithubFactsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        autoMergeAllowed: true,
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        viewerDefaultMergeMethod: "SQUASH",
        pullRequest: {
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: true,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: true,
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
        ...overrides,
      },
    },
  });
}

function createCurrentPullRequestStatus(
  overrides: Partial<CurrentPullRequestStatus> = {},
): CurrentPullRequestStatus {
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
    mergeable: "MERGEABLE",
    checks: [],
    checksStatus: "none",
    reviewDecision: null,
    ...overrides,
  };
}

function githubStatusFacts(
  overrides: Partial<GitHubPullRequestStatusFacts> = {},
): GitHubPullRequestStatusFacts & { forge: "github" } {
  return {
    forge: "github",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: false,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  };
}

function recordCurrentPullRequestStatusReads(service: ReturnType<typeof createGitHubService>) {
  const reads: Parameters<typeof service.getCurrentPullRequestStatus>[0][] = [];
  const getCurrentPullRequestStatus = service.getCurrentPullRequestStatus.bind(service);
  service.getCurrentPullRequestStatus = vi.fn(async (options) => {
    reads.push(options);
    return getCurrentPullRequestStatus(options);
  });
  return reads;
}

function currentPullRequestStatusCalls(calls: RunnerCall[]): RunnerCall[] {
  return calls.filter(
    (call) => call.args[0] === "pr" && (call.args[1] === "view" || call.args[1] === "list"),
  );
}

function noPullRequestError(args: string[] = ["pr", "view"]): GitHubCommandError {
  return new GitHubCommandError({
    args,
    cwd: "/repo",
    exitCode: 1,
    stderr: "no pull requests found for branch",
  });
}

function statusCheckRollupPermissionError(args: string[]): GitHubCommandError {
  return new GitHubCommandError({
    args,
    cwd: "/repo",
    exitCode: 1,
    stderr:
      "GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup)",
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
                bodyHTML: "<p>Looks good to me.</p>",
                url: "https://github.com/parentOwner/parentRepo/pull/42#pullrequestreview-1",
                submittedAt: "2026-04-02T13:52:14Z",
                author: {
                  login: "reviewer",
                  url: "https://github.com/reviewer",
                  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
                },
              },
              {
                id: "PRR_empty_commented",
                state: "COMMENTED",
                body: "",
                bodyHTML: "",
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
                bodyHTML: "<p>Can we add a regression test?</p>",
                url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-3",
                createdAt: "2026-04-02T13:55:00Z",
                author: {
                  login: "commenter",
                  url: "https://github.com/commenter",
                  avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
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

describe("ForgeService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["merge", ["pr", "merge", "42", "--merge"]],
    ["squash", ["pr", "merge", "42", "--squash"]],
    ["rebase", ["pr", "merge", "42", "--rebase"]],
  ] as const)("merges pull requests with gh using %s", async (mergeMethod, expectedArgs) => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.mergePullRequest({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod,
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts(),
        }),
      }),
    ).resolves.toEqual({ success: true });

    expect(runner.calls).toEqual([
      {
        args: expectedArgs,
        cwd: "/tmp/repo",
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      },
    ]);
  });

  it("rejects direct merge when GitHub facts are unavailable", async () => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.mergePullRequest({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod: "squash",
        status: createCurrentPullRequestStatus(),
      }),
    ).rejects.toThrow("GitHub merge facts are unavailable");

    expect(runner.calls).toEqual([]);
  });

  it.each(["BLOCKED", "DIRTY", null] as const)(
    "rejects direct merge when GitHub mergeStateStatus is %s",
    async (mergeStateStatus) => {
      const runner = createRunner([""]);
      const service = createGitHubService({
        runner: runner.runner,
      });

      await expect(
        service.mergePullRequest({
          cwd: "/tmp/repo",
          prNumber: 42,
          mergeMethod: "squash",
          status: createCurrentPullRequestStatus({
            forgeSpecific: githubStatusFacts({ mergeStateStatus }),
          }),
        }),
      ).rejects.toThrow("ready for direct merge");

      expect(runner.calls).toEqual([]);
    },
  );

  it.each([
    ["merge queue enabled", { isMergeQueueEnabled: true }],
    ["PR already in merge queue", { isInMergeQueue: true }],
  ] as const)("rejects direct merge when %s", async (_name, overrides) => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.mergePullRequest({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod: "squash",
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts(overrides),
        }),
      }),
    ).rejects.toThrow("merge queue");

    expect(runner.calls).toEqual([]);
  });

  it("rejects direct merge when auto-merge is already enabled", async () => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.mergePullRequest({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod: "squash",
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts({
            autoMergeRequest: {
              enabledAt: "2026-05-13T12:00:00Z",
              mergeMethod: "SQUASH",
              enabledBy: "octocat",
            },
          }),
        }),
      }),
    ).rejects.toThrow("auto-merge is already enabled");

    expect(runner.calls).toEqual([]);
  });

  it("rejects direct merge when the requested method is disabled by repository policy", async () => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.mergePullRequest({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod: "squash",
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts({
            repository: {
              autoMergeAllowed: true,
              mergeCommitAllowed: true,
              squashMergeAllowed: false,
              rebaseMergeAllowed: true,
              viewerDefaultMergeMethod: "MERGE",
            },
          }),
        }),
      }),
    ).rejects.toThrow("squash is disabled");

    expect(runner.calls).toEqual([]);
  });

  it.each([
    ["merge", ["pr", "merge", "42", "--auto", "--merge"]],
    ["squash", ["pr", "merge", "42", "--auto", "--squash"]],
    ["rebase", ["pr", "merge", "42", "--auto", "--rebase"]],
  ] as const)("enables auto-merge with gh using %s", async (mergeMethod, expectedArgs) => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.enablePullRequestAutoMerge({
        cwd: "/tmp/repo",
        prNumber: 42,
        mergeMethod,
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts({
            mergeStateStatus: "BLOCKED",
            viewerCanEnableAutoMerge: true,
            repository: {
              autoMergeAllowed: true,
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerDefaultMergeMethod: "SQUASH",
            },
          }),
        }),
      }),
    ).resolves.toEqual({ success: true });

    expect(runner.calls).toEqual([
      {
        args: expectedArgs,
        cwd: "/tmp/repo",
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      },
    ]);
  });

  it("disables auto-merge with gh", async () => {
    const runner = createRunner([""]);
    const service = createGitHubService({
      runner: runner.runner,
    });

    await expect(
      service.disablePullRequestAutoMerge({
        cwd: "/tmp/repo",
        prNumber: 42,
        status: createCurrentPullRequestStatus({
          forgeSpecific: githubStatusFacts({
            autoMergeRequest: {
              enabledAt: "2026-05-13T12:00:00Z",
              mergeMethod: "SQUASH",
              enabledBy: "octocat",
            },
            viewerCanDisableAutoMerge: true,
          }),
        }),
      }),
    ).resolves.toEqual({ success: true });

    expect(runner.calls).toEqual([
      {
        args: ["pr", "merge", "42", "--disable-auto"],
        cwd: "/tmp/repo",
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      },
    ]);
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
      checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/526/head" }],
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

  it("populates repoOwner/repoName from a GitHub Enterprise PR URL", async () => {
    const runner = createRunner([
      currentPullRequestJson({ url: "https://github.acme.internal/acme/repo/pull/42" }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 0,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
    });

    expect(status).toMatchObject({
      repoOwner: "acme",
      repoName: "repo",
      url: "https://github.acme.internal/acme/repo/pull/42",
    });
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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(2);
    expect(reads.map((read) => read.reason)).toEqual([undefined, "self-heal-github"]);

    subscription?.unsubscribe();
    service.dispose?.();
  });

  it("retained fork PR status polls keep the head repository owner", async () => {
    const runner = createRunner([
      currentPullRequestJson({
        headRefName: "open-button-targets-active-file",
        headRepositoryOwner: { login: "fork-owner" },
      }),
    ]);
    const service = createGitHubService({
      ttlMs: 0,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });
    const reads = recordCurrentPullRequestStatusReads(service);

    const subscription = service.retainCurrentPullRequestStatusPoll?.({
      cwd: "/repo",
      headRef: "open-button-targets-active-file",
      headRepositoryOwner: "fork-owner",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reads).toEqual([
      expect.objectContaining({
        cwd: "/repo",
        headRef: "open-button-targets-active-file",
        headRepositoryOwner: "fork-owner",
        reason: "self-heal-github",
      }),
    ]);
    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);

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
    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);

    now = EXPECTED_GITHUB_SLOW_POLL_MS;
    await vi.advanceTimersByTimeAsync(EXPECTED_GITHUB_SLOW_POLL_MS - EXPECTED_GITHUB_FAST_POLL_MS);
    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(2);
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
      currentPullRequestGithubFactsJson(),
      { error: new Error("network down") },
      { error: new Error("network still down") },
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
      currentPullRequestGithubFactsJson(),
      currentPullRequestJson({
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
      }),
      currentPullRequestGithubFactsJson(),
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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(5);
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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);

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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);
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
    expect(runner.calls[0]?.args[3]).toContain("bodyHTML");
    expect(runner.calls[0]?.args[3]).toContain("avatarUrl");
    expect(runner.calls[0]?.args[3]).toContain("reviewThreads(first: 100)");
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
          avatarUrl: null,
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
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
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
          avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
          body: "Can we add a regression test?",
          createdAt: Date.parse("2026-04-02T13:55:00Z"),
          url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-3",
        },
      ],
    });
  });

  it("rewrites GitHub attachment image URLs in timeline comments", async () => {
    const privateAttachmentUrl =
      "https://private-user-images.githubusercontent.com/123/asset.png?jwt=abc&expires=123";
    const runner = createRunner([
      pullRequestTimelineJson({
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        comments: {
          nodes: [
            {
              id: "IC_attachment",
              body: "Screenshot: ![bug](https://github.com/user-attachments/assets/raw-asset)",
              bodyHTML: `<p>Screenshot: <img alt="bug" src="${privateAttachmentUrl.replaceAll("&", "&amp;")}" /></p>`,
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-4",
              createdAt: "2026-04-02T13:56:00Z",
              author: null,
            },
          ],
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

    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      id: "IC_attachment",
      body: `Screenshot: ![bug](${privateAttachmentUrl})`,
    });
  });

  it("rewrites GitHub attachment image URLs in review thread comments", async () => {
    const privateAttachmentUrl =
      "https://private-user-images.githubusercontent.com/123/thread.png?jwt=thread";
    const runner = createRunner([
      pullRequestTimelineJson({
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        comments: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_attachment",
              path: "packages/app/src/git/pull-request-panel/data.ts",
              line: 24,
              startLine: 20,
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: [
                  {
                    id: "PRRC_attachment",
                    body: '<img src="https://github.com/user-attachments/assets/thread-asset" alt="thread" />',
                    bodyHTML: `<p><img alt="thread" src="${privateAttachmentUrl}" /></p>`,
                    url: "https://github.com/parentOwner/parentRepo/pull/42#discussion_r2",
                    createdAt: "2026-04-02T13:51:00Z",
                    author: null,
                    pullRequestReview: { id: "PRR_empty_commented" },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
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

    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      id: "PRRC_attachment",
      body: `<img src="${privateAttachmentUrl}" alt="thread" />`,
    });
  });

  it("leaves external badge images unchanged", async () => {
    const runner = createRunner([
      pullRequestTimelineJson({
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        comments: {
          nodes: [
            {
              id: "IC_badge",
              body: "![build](https://img.shields.io/github/actions/workflow/status/getpaseo/paseo/ci.yml)",
              bodyHTML:
                '<p><img alt="build" src="https://camo.githubusercontent.com/badge-signature" /></p>',
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-5",
              createdAt: "2026-04-02T13:57:00Z",
              author: null,
            },
          ],
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

    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      id: "IC_badge",
      body: "![build](https://img.shields.io/github/actions/workflow/status/getpaseo/paseo/ci.yml)",
    });
  });

  it("leaves GitHub attachment image URLs unchanged when rendered images do not match", async () => {
    const body = "![bug](https://github.com/user-attachments/assets/raw-asset)";
    const runner = createRunner([
      pullRequestTimelineJson({
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false },
        },
        comments: {
          nodes: [
            {
              id: "IC_mismatch",
              body,
              bodyHTML: "<p>No rendered image.</p>",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-6",
              createdAt: "2026-04-02T13:58:00Z",
              author: null,
            },
          ],
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

    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      id: "IC_mismatch",
      body,
    });
  });

  it("maps inline review thread comments as chronological PR timeline comments with location", async () => {
    const runner = createRunner([
      pullRequestTimelineJson({
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              path: "packages/app/src/git/pull-request-panel/data.ts",
              line: 24,
              startLine: 20,
              isResolved: true,
              isOutdated: false,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    body: "This should include line context.",
                    bodyHTML: "<p>This should include line context.</p>",
                    url: "https://github.com/parentOwner/parentRepo/pull/42#discussion_r1",
                    createdAt: "2026-04-02T13:51:00Z",
                    author: {
                      login: "inline-reviewer",
                      url: "https://github.com/inline-reviewer",
                      avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
                    },
                    pullRequestReview: { id: "PRR_empty_commented" },
                  },
                ],
                pageInfo: { hasNextPage: true },
              },
            },
          ],
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

    expect(timeline.truncated).toBe(true);
    expect(timeline.items.map((item) => item.id)).toEqual([
      "PRR_empty_commented",
      "PRRC_1",
      "PRR_approved",
      "IC_later",
    ]);
    expect(timeline.items[1]).toEqual({
      kind: "comment",
      id: "PRRC_1",
      author: "inline-reviewer",
      authorUrl: "https://github.com/inline-reviewer",
      avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
      body: "This should include line context.",
      createdAt: Date.parse("2026-04-02T13:51:00Z"),
      url: "https://github.com/parentOwner/parentRepo/pull/42#discussion_r1",
      reviewId: "PRR_empty_commented",
      location: {
        path: "packages/app/src/git/pull-request-panel/data.ts",
        line: 24,
        startLine: 20,
        threadId: "PRRT_1",
        isResolved: true,
        isOutdated: false,
      },
    });
    expect(runner.calls[0]?.args[3]).toContain("pullRequestReview");
  });

  it("keeps inline review thread comments once when they also appear in PR comments", async () => {
    const runner = createRunner([
      pullRequestTimelineJson({
        comments: {
          nodes: [
            {
              id: "PRRC_1",
              body: "This should include line context.",
              url: "https://github.com/parentOwner/parentRepo/pull/42#discussion_r1",
              createdAt: "2026-04-02T13:51:00Z",
              author: {
                login: "inline-reviewer",
                url: "https://github.com/inline-reviewer",
                avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
              },
            },
            {
              id: "IC_later",
              body: "Can we add a regression test?",
              url: "https://github.com/parentOwner/parentRepo/pull/42#issuecomment-3",
              createdAt: "2026-04-02T13:55:00Z",
              author: {
                login: "commenter",
                url: "https://github.com/commenter",
                avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              path: "packages/app/src/git/pull-request-panel/data.ts",
              line: 24,
              startLine: 20,
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: [
                  {
                    id: "PRRC_1",
                    body: "This should include line context.",
                    url: "https://github.com/parentOwner/parentRepo/pull/42#discussion_r1",
                    createdAt: "2026-04-02T13:51:00Z",
                    author: {
                      login: "inline-reviewer",
                      url: "https://github.com/inline-reviewer",
                      avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
                    },
                    pullRequestReview: { id: "PRR_empty_commented" },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
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

    expect(timeline.items.map((item) => item.id)).toEqual([
      "PRR_empty_commented",
      "PRRC_1",
      "PRR_approved",
      "IC_later",
    ]);
    expect(timeline.items[1]).toMatchObject({
      id: "PRRC_1",
      reviewId: "PRR_empty_commented",
      location: {
        path: "packages/app/src/git/pull-request-panel/data.ts",
        line: 24,
        startLine: 20,
        threadId: "PRRT_1",
      },
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
      resolveRepoHost: async () => null,
      now: () => 100,
    });
    const request = {
      cwd: "/repo",
      prNumber: 42,
      repoOwner: "parentOwner",
      repoName: "parentRepo",
    };

    const staleRequest = service.getPullRequestTimeline(request);
    await flushMicrotasks();
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
    await flushMicrotasks();
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
            databaseId: 12345,
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

    expect(runner.calls[0]?.args).toEqual(["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS]);
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
      mergeable: "UNKNOWN",
      checks: [
        {
          name: "server-tests",
          status: "success",
          url: "https://github.com/acme/repo/actions/runs/123",
          workflow: "Server CI",
          duration: "2m 14s",
          checkRunId: 12345,
          workflowRunId: 123,
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

  it("fetches GitHub check details with capped failed job log tails and reuses cached logs", async () => {
    const longLog = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n");
    const runner = createRunner([
      JSON.stringify({
        id: 12345,
        name: "server-tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        details_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        output: {
          title: "Tests failed",
          summary: "1 failure",
          text: "Assertion failed",
        },
        check_suite: {
          workflow_run: {
            id: 456,
          },
        },
      }),
      JSON.stringify([
        {
          path: "packages/server/src/index.ts",
          start_line: 10,
          end_line: 12,
          annotation_level: "failure",
          message: "Expected true",
          title: "server test failed",
          raw_details: "stack trace",
        },
      ]),
      JSON.stringify({
        jobs: [
          {
            id: 789,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
            completed_at: "2026-04-02T13:52:14Z",
          },
          {
            id: 790,
            name: "lint",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/repo/actions/runs/456/job/790",
            completed_at: "2026-04-02T13:52:15Z",
          },
        ],
      }),
      longLog,
      JSON.stringify({
        id: 12345,
        name: "server-tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        check_suite: { workflow_run: { id: 456 } },
      }),
      JSON.stringify([]),
      JSON.stringify({
        jobs: [
          {
            id: 789,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
            completed_at: "2026-04-02T13:52:14Z",
          },
        ],
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const first = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "repo",
      checkRunId: 12345,
    });
    const second = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "repo",
      checkRunId: 12345,
      force: true,
      reason: "verify-log-cache",
    });

    expect(first).toEqual({
      checkRunId: 12345,
      workflowRunId: 456,
      name: "server-tests",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/repo/actions/runs/456/job/789",
      detailsUrl: "https://github.com/acme/repo/actions/runs/456/job/789",
      output: {
        title: "Tests failed",
        summary: "1 failure",
        text: "Assertion failed",
      },
      annotations: [
        {
          path: "packages/server/src/index.ts",
          startLine: 10,
          endLine: 12,
          annotationLevel: "failure",
          message: "Expected true",
          title: "server test failed",
          rawDetails: "stack trace",
        },
      ],
      failedJobs: [
        {
          jobId: 789,
          name: "test",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/acme/repo/actions/runs/456/job/789",
          logTail: Array.from({ length: 200 }, (_, index) => `line ${index + 21}`).join("\n"),
          logTruncated: true,
        },
      ],
      truncated: true,
    });
    expect(second.failedJobs[0]?.logTail).toBe(first.failedJobs[0]?.logTail);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "repos/acme/repo/check-runs/12345"],
      ["api", "repos/acme/repo/check-runs/12345/annotations", "-f", "per_page=20"],
      ["api", "repos/acme/repo/actions/runs/456/jobs", "-f", "per_page=100"],
      ["api", "repos/acme/repo/actions/jobs/789/logs"],
      ["api", "repos/acme/repo/check-runs/12345"],
      ["api", "repos/acme/repo/check-runs/12345/annotations", "-f", "per_page=20"],
      ["api", "repos/acme/repo/actions/runs/456/jobs", "-f", "per_page=100"],
    ]);
  });

  it("caps failed check jobs at five and caps each log tail to 16 KiB", async () => {
    const oversizedLog = "x".repeat(20 * 1024);
    const failedJobs = Array.from({ length: 6 }, (_, index) => ({
      id: 800 + index,
      name: `failed-${index + 1}`,
      status: "completed",
      conclusion: "failure",
      html_url: `https://github.com/acme/repo/actions/runs/456/job/${800 + index}`,
      completed_at: `2026-04-02T13:52:${10 + index}Z`,
    }));
    const runner = createRunner([
      JSON.stringify({
        id: 12345,
        name: "server-tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        check_suite: { workflow_run: { id: 456 } },
      }),
      JSON.stringify([]),
      JSON.stringify({ jobs: failedJobs }),
      oversizedLog,
      oversizedLog,
      oversizedLog,
      oversizedLog,
      oversizedLog,
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "repo",
      checkRunId: 12345,
    });

    expect(details.failedJobs.map((job) => job.jobId)).toEqual([800, 801, 802, 803, 804]);
    expect(details.failedJobs.map((job) => job.logTruncated)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(details.failedJobs.map((job) => Buffer.byteLength(job.logTail ?? "", "utf8"))).toEqual([
      16 * 1024,
      16 * 1024,
      16 * 1024,
      16 * 1024,
      16 * 1024,
    ]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["api", "repos/acme/repo/check-runs/12345"],
      ["api", "repos/acme/repo/check-runs/12345/annotations", "-f", "per_page=20"],
      ["api", "repos/acme/repo/actions/runs/456/jobs", "-f", "per_page=100"],
      ["api", "repos/acme/repo/actions/jobs/800/logs"],
      ["api", "repos/acme/repo/actions/jobs/801/logs"],
      ["api", "repos/acme/repo/actions/jobs/802/logs"],
      ["api", "repos/acme/repo/actions/jobs/803/logs"],
      ["api", "repos/acme/repo/actions/jobs/804/logs"],
    ]);
    expect(details.truncated).toBe(true);
  });

  it("marks check details truncated when annotations hit the page cap", async () => {
    const annotations = Array.from({ length: 20 }, (_, index) => ({
      path: `packages/server/src/file-${index}.ts`,
      start_line: index + 1,
      annotation_level: "failure",
      message: `Failure ${index + 1}`,
    }));
    const runner = createRunner([
      JSON.stringify({
        id: 12345,
        name: "server-tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        check_suite: { workflow_run: { id: 456 } },
      }),
      JSON.stringify(annotations),
      JSON.stringify({ jobs: [] }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "repo",
      checkRunId: 12345,
    });

    expect(details.annotations).toHaveLength(20);
    expect(details.truncated).toBe(true);
  });

  it("marks check details truncated when workflow jobs hit the page cap", async () => {
    const jobs = Array.from({ length: 100 }, (_, index) => ({
      id: 900 + index,
      name: `job-${index + 1}`,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/acme/repo/actions/runs/456/job/${900 + index}`,
      completed_at: `2026-04-02T13:52:${String(index % 60).padStart(2, "0")}Z`,
    }));
    const runner = createRunner([
      JSON.stringify({
        id: 12345,
        name: "server-tests",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/acme/repo/actions/runs/456/job/789",
        check_suite: { workflow_run: { id: 456 } },
      }),
      JSON.stringify([]),
      JSON.stringify({ jobs }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const details = await service.getCheckDetails({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "repo",
      checkRunId: 12345,
    });

    expect(details.failedJobs).toEqual([]);
    expect(details.truncated).toBe(true);
  });

  it("retries current PR view without statusCheckRollup when token permissions are insufficient", async () => {
    const runner = createScriptedRunner([
      {
        error: statusCheckRollupPermissionError(["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS]),
      },
      currentPullRequestJson({
        headRefName: "feature/pr-pane",
        reviewDecision: "APPROVED",
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

    expect(runner.calls.slice(0, 2).map((call) => call.args)).toEqual([
      ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
      ["pr", "view", "--json", CURRENT_PR_STATUS_BASE_FIELDS],
    ]);
    expect(status).toMatchObject({
      title: "Fork PR",
      headRefName: "feature/pr-pane",
      checks: [],
      checksStatus: "none",
      reviewDecision: "approved",
    });
  });

  it("defaults unexpected PR mergeability values to unknown", async () => {
    const runner = createRunner([
      currentPullRequestJson({
        mergeable: "",
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
    });

    expect(status?.mergeable).toBe("UNKNOWN");
  });

  it("keeps an open PR when its remote head SHA differs from the checkout HEAD", async () => {
    const runner = createRunner([
      currentPullRequestJson({
        headRefOid: "1111111111111111111111111111111111111111",
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
      headSha: "2222222222222222222222222222222222222222",
    });

    expect(status).toMatchObject({ number: 42, state: "open" });
  });

  it("loads GitHub merge, auto-merge, permission, policy, and queue facts for PR 993 shape", async () => {
    const runner = createScriptedRunner([
      currentPullRequestJson({
        number: 993,
        url: "https://github.com/getpaseo/paseo/pull/993",
        title: "Auto-merge UX",
        headRefName: "github-pr-auto-merge-ux",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "server tests",
            workflowName: "CI",
            status: "IN_PROGRESS",
            conclusion: null,
            detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/993",
          },
        ],
      }),
      currentPullRequestGithubFactsJson(),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "github-pr-auto-merge-ux",
    });

    expect(runner.calls.map((call) => call.args[0])).toEqual(["pr", "api"]);
    expect(status).toMatchObject({
      number: 993,
      mergeable: "MERGEABLE",
      checks: [
        {
          name: "server tests",
          status: "pending",
          url: "https://github.com/getpaseo/paseo/actions/runs/993",
          workflow: "CI",
        },
      ],
      checksStatus: "pending",
      forgeSpecific: {
        forge: "github",
        mergeStateStatus: "BLOCKED",
        autoMergeRequest: null,
        viewerCanEnableAutoMerge: true,
        viewerCanDisableAutoMerge: false,
        viewerCanMergeAsAdmin: false,
        viewerCanUpdateBranch: true,
        repository: {
          autoMergeAllowed: true,
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: "SQUASH",
        },
        isMergeQueueEnabled: false,
        isInMergeQueue: false,
      },
    });
  });

  it("keeps a merged PR only when headRefOid matches the checkout HEAD", async () => {
    const headSha = "2222222222222222222222222222222222222222";
    const runner = createRunner([
      currentPullRequestJson({
        state: "MERGED",
        mergedAt: "2026-07-17T12:00:00Z",
        headRefOid: headSha,
      }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
      headSha,
    });

    expect(status?.number).toBe(42);
    expect(status?.state).toBe("merged");
  });

  it("does not attach a stale merged PR after a same-name branch advances", async () => {
    const stale = currentPullRequestJson({
      state: "MERGED",
      mergedAt: "2026-07-17T12:00:00Z",
      headRefOid: "1111111111111111111111111111111111111111",
    });
    const runner = createScriptedRunner([
      stale,
      JSON.stringify({ owner: { login: "parentOwner" }, name: "parentRepo", parent: null }),
      JSON.stringify([JSON.parse(stale)]),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature/fork",
        headSha: "2222222222222222222222222222222222222222",
      }),
    ).resolves.toBeNull();
    expect(runner.calls.some((call) => call.args[0] === "pr" && call.args[1] === "list")).toBe(
      true,
    );
  });

  it("prefers an open PR over an exact-SHA merged PR for the same head", async () => {
    const checkoutSha = "2222222222222222222222222222222222222222";
    const owner = { login: "forkOwner" };
    const staleView = currentPullRequestJson({
      state: "MERGED",
      mergedAt: "2026-07-15T12:00:00Z",
      headRefOid: "0000000000000000000000000000000000000000",
      headRepositoryOwner: owner,
    });
    const open = JSON.parse(
      currentPullRequestJson({
        number: 43,
        state: "OPEN",
        headRefOid: "3333333333333333333333333333333333333333",
        headRepositoryOwner: owner,
      }),
    );
    const exactMerged = JSON.parse(
      currentPullRequestJson({
        number: 42,
        state: "MERGED",
        mergedAt: "2026-07-16T12:00:00Z",
        headRefOid: checkoutSha,
        headRepositoryOwner: owner,
      }),
    );
    const runner = createScriptedRunner([staleView, JSON.stringify([exactMerged, open])]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/fork",
      headSha: checkoutSha,
      headRepositoryOwner: "forkOwner",
    });

    expect(status).toMatchObject({ number: 43, state: "open" });
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
    expect(runner.calls.slice(0, 3).map((call) => call.args)).toEqual([
      ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
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
        "--limit",
        "10",
        "--json",
        CURRENT_PR_STATUS_FIELDS,
      ],
    ]);
  });

  it("retries scoped PR list without statusCheckRollup when token permissions are insufficient", async () => {
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
      {
        error: statusCheckRollupPermissionError([
          "pr",
          "list",
          "--repo",
          "parentOwner/parentRepo",
          "--state",
          "all",
          "--head",
          "forkOwner:feature/fork",
          "--json",
          CURRENT_PR_STATUS_FIELDS,
          "--limit",
          "10",
        ]),
      },
      JSON.stringify([
        {
          number: 42,
          url: "https://github.com/parentOwner/parentRepo/pull/42",
          title: "Real fork PR",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/fork",
          mergedAt: null,
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
      headRefName: "feature/fork",
      checks: [],
      checksStatus: "none",
    });
    expect(runner.calls.slice(0, 4).map((call) => call.args)).toEqual([
      ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
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
        "--limit",
        "10",
        "--json",
        CURRENT_PR_STATUS_FIELDS,
      ],
      [
        "pr",
        "list",
        "--repo",
        "parentOwner/parentRepo",
        "--state",
        "all",
        "--head",
        "forkOwner:feature/fork",
        "--limit",
        "10",
        "--json",
        CURRENT_PR_STATUS_BASE_FIELDS,
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
      ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
      ["repo", "view", "--json", "owner,name,parent"],
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "main",
        "--limit",
        "10",
        "--json",
        CURRENT_PR_STATUS_FIELDS,
      ],
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
    expect(runner.calls.slice(0, 2).map((call) => call.args)).toEqual([
      ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
      [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "main",
        "--limit",
        "10",
        "--json",
        CURRENT_PR_STATUS_FIELDS,
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
        featuresEnabled: true,
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
        featuresEnabled: true,
        githubFeaturesEnabled: true,
        error: null,
        requestId: "req-new",
      },
    });

    expect(newDaemonResponse.payload.status).toEqual({
      forge: "github",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "New daemon payload",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
      isDraft: true,
      mergeable: "UNKNOWN",
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
      resolveRepoHost: async () => null,
      now: () => 100,
    });

    const first = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    const second = service.listPullRequests({ cwd: "/repo", query: "bug", limit: 10 });
    await flushMicrotasks();
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

  it("throws a typed command error for malformed JSON output", async () => {
    const runner = createRunner(["not-json"]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toMatchObject({
      kind: "command-error",
      args: [
        "pr",
        "list",
        "--search",
        "",
        "--json",
        "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
        "--limit",
        "20",
      ],
      cwd: "/repo",
      exitCode: null,
      stderr: "gh did not return valid JSON (8 bytes)",
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
      featuresEnabled: true,
      authState: "authenticated",
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "change_request",
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

  it("treats a GitHub issue or PR URL as a search for that number", async () => {
    const runner = createRunner([issueJson("Issue title"), searchPullRequestJson("PR title")]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => 100,
    });

    await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "https://github.com/getpaseo/paseo/pull/793",
      limit: 5,
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "issue",
        "list",
        "--search",
        "793",
        "--json",
        "number,title,url,state,body,labels,updatedAt",
        "--limit",
        "5",
      ],
      [
        "pr",
        "list",
        "--search",
        "793",
        "--json",
        "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
        "--limit",
        "5",
      ],
    ]);
  });

  it("does not treat an unrelated tracker URL as a GitHub issue/PR number", async () => {
    const runner = createRunner([issueJson("Issue title"), searchPullRequestJson("PR title")]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      resolveRepoHost: async () => null,
      now: () => 100,
    });

    await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "https://gitlab.com/getpaseo/paseo/issues/793",
      limit: 5,
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "issue",
        "list",
        "--search",
        "https://gitlab.com/getpaseo/paseo/issues/793",
        "--json",
        "number,title,url,state,body,labels,updatedAt",
        "--limit",
        "5",
      ],
      [
        "pr",
        "list",
        "--search",
        "https://gitlab.com/getpaseo/paseo/issues/793",
        "--json",
        "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
        "--limit",
        "5",
      ],
    ]);
  });

  it("treats a GitHub Enterprise issue/PR URL as a search for that number", async () => {
    const runner = createRunner([issueJson("Issue title"), searchPullRequestJson("PR title")]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      resolveRepoHost: async () => "github.acme.internal",
      now: () => 100,
    });

    await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "https://github.acme.internal/getpaseo/paseo/pull/793",
      limit: 5,
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        "issue",
        "list",
        "--search",
        "793",
        "--json",
        "number,title,url,state,body,labels,updatedAt",
        "--limit",
        "5",
      ],
      [
        "pr",
        "list",
        "--search",
        "793",
        "--json",
        "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
        "--limit",
        "5",
      ],
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
      featuresEnabled: true,
      authState: "authenticated",
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "change_request",
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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);
  });

  it("bypasses the warm PR status cache for forced reads", async () => {
    const runner = createRunner([
      currentPullRequestJson({ number: 41, title: "First" }),
      currentPullRequestGithubFactsJson(),
      currentPullRequestJson({ number: 42, title: "Forced" }),
      currentPullRequestGithubFactsJson(),
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

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(2);
  });

  it("coalesces concurrent PR status callers", async () => {
    const runner = createDeferredRunner();
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      resolveRepoHost: async () => null,
      now: () => 100,
    });

    const first = service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    const second = service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "feature/fork" });
    await flushMicrotasks();

    expect(currentPullRequestStatusCalls(runner.calls)).toHaveLength(1);
    runner.resolveNext(currentPullRequestJson());
    for (let i = 0; i < 10 && runner.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(runner.calls[1]?.args[0]).toBe("api");
    runner.resolveNext(currentPullRequestGithubFactsJson());

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
    ).rejects.toThrow("ForgeService forced read requires a reason");
  });

  it("type: force true requires a reason", () => {
    // @ts-expect-error force: true requires reason
    const invalid: ForgeReadOptions = { force: true };
    const valid: ForgeReadOptions = { force: true, reason: "test" };

    expect(invalid.force).toBe(true);
    expect(valid.reason).toBe("test");
  });

  it("resolves the repo slug from the workspace when creating a pull request", async () => {
    const runner = createRunner([
      JSON.stringify({ owner: { login: "acme" }, name: "repo" }),
      JSON.stringify({ url: "https://github.com/acme/repo/pull/7", number: 7 }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveRepoHost: async () => null,
    });

    await expect(
      service.createPullRequest({
        cwd: "/tmp/repo",
        title: "Add thing",
        head: "feature",
        base: "main",
      }),
    ).resolves.toEqual({ url: "https://github.com/acme/repo/pull/7", number: 7 });

    expect(runner.calls[0]?.args).toEqual(["repo", "view", "--json", "owner,name,parent"]);
    expect(runner.calls[1]?.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/repo/pulls",
      "-f",
      "title=Add thing",
      "-f",
      "head=feature",
      "-f",
      "base=main",
    ]);
  });

  it("routes gh calls to the resolved GitHub Enterprise host via GH_HOST", async () => {
    const runner = createRunner([
      JSON.stringify({ owner: { login: "acme" }, name: "repo" }),
      JSON.stringify({ url: "https://github.acme.internal/acme/repo/pull/7", number: 7 }),
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveRepoHost: async () => "github.acme.internal",
    });

    await expect(
      service.createPullRequest({
        cwd: "/tmp/repo",
        title: "Add thing",
        head: "feature",
        base: "main",
      }),
    ).resolves.toEqual({ url: "https://github.acme.internal/acme/repo/pull/7", number: 7 });

    expect(runner.calls[1]?.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/acme/repo/pulls",
      "-f",
      "title=Add thing",
      "-f",
      "head=feature",
      "-f",
      "base=main",
    ]);
    // GH_HOST is injected on every gh call (the slug lookup and the POST alike).
    expect(runner.calls[0]?.envOverlay).toMatchObject({ GH_HOST: "github.acme.internal" });
    expect(runner.calls[1]?.envOverlay).toMatchObject({ GH_HOST: "github.acme.internal" });
  });

  it.skipIf(isPlatform("win32"))(
    "routes default gh calls to GitHub Enterprise only after host auth succeeds",
    async () => {
      vi.useRealTimers();
      const fixture = createFakeGitHubCliFixture({
        remoteUrl: "https://github.acme.internal/acme/repo.git",
        authStatusSucceeds: true,
      });
      try {
        const service = createGitHubService();

        await expect(
          service.createPullRequest({
            cwd: fixture.cwd,
            title: "Add thing",
            head: "feature",
            base: "main",
          }),
        ).resolves.toEqual({ url: "https://github.acme.internal/acme/repo/pull/7", number: 7 });

        expect(readFakeGitHubCliLog(fixture.logPath)).toEqual(
          expect.arrayContaining([
            "auth status --hostname github.acme.internal|",
            "repo view --json owner,name,parent|github.acme.internal",
            "api -X POST repos/acme/repo/pulls -f title=Add thing -f head=feature -f base=main|github.acme.internal",
          ]),
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it.skipIf(isPlatform("win32"))(
    "retries GitHub Enterprise host probing after a transient auth-status failure",
    async () => {
      vi.useRealTimers();
      const fixture = createFakeGitHubCliFixture({
        remoteUrl: "https://github.acme.internal/acme/repo.git",
        authStatusMode: "transient-once",
      });
      try {
        const service = createGitHubService();

        await expect(
          service.createPullRequest({
            cwd: fixture.cwd,
            title: "Add thing",
            head: "feature",
            base: "main",
          }),
        ).rejects.toThrow("Unable to verify GitHub Enterprise host github.acme.internal");

        await expect(
          service.createPullRequest({
            cwd: fixture.cwd,
            title: "Add thing",
            head: "feature",
            base: "main",
          }),
        ).resolves.toEqual({ url: "https://github.acme.internal/acme/repo/pull/7", number: 7 });

        const log = readFakeGitHubCliLog(fixture.logPath);
        expect(
          log.filter((line) => line === "auth status --hostname github.acme.internal|"),
        ).toHaveLength(2);
        expect(log).toEqual(
          expect.arrayContaining([
            "repo view --json owner,name,parent|github.acme.internal",
            "api -X POST repos/acme/repo/pulls -f title=Add thing -f head=feature -f base=main|github.acme.internal",
          ]),
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it.skipIf(isPlatform("win32"))(
    "fails instead of routing gh calls to github.com for an unauthenticated Enterprise host",
    async () => {
      vi.useRealTimers();
      const fixture = createFakeGitHubCliFixture({
        remoteUrl: "https://github.acme.internal/acme/repo.git",
        authStatusSucceeds: false,
      });
      try {
        const service = createGitHubService();

        // An unauthenticated Enterprise host must fail, not silently proceed
        // against github.com (the default when GH_HOST is unset).
        await expect(
          service.createPullRequest({
            cwd: fixture.cwd,
            title: "Add thing",
            head: "feature",
            base: "main",
          }),
        ).rejects.toThrow(/authentication failed/i);

        const log = readFakeGitHubCliLog(fixture.logPath);
        expect(log).toContain("auth status --hostname github.acme.internal|");
        // It threw at host resolution, before running any api/graphql call.
        expect(log.some((line) => line.startsWith("api ") || line.startsWith("graphql"))).toBe(
          false,
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it.skipIf(isPlatform("win32"))("does not probe or route github.com through GH_HOST", async () => {
    vi.useRealTimers();
    const fixture = createFakeGitHubCliFixture({
      remoteUrl: "https://github.com/acme/repo.git",
      authStatusSucceeds: false,
    });
    try {
      const service = createGitHubService();

      await expect(
        service.createPullRequest({
          cwd: fixture.cwd,
          title: "Add thing",
          head: "feature",
          base: "main",
        }),
      ).resolves.toEqual({ url: "https://github.acme.internal/acme/repo/pull/7", number: 7 });

      const log = readFakeGitHubCliLog(fixture.logPath);
      expect(log.some((line) => line.startsWith("auth status --hostname "))).toBe(false);
      expect(log.every((line) => line.endsWith("|"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("caches definitive null repo host resolutions", async () => {
    const runner = createRunner(["[]", "[]"]);
    let hostResolutions = 0;
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      resolveRepoHost: async () => {
        hostResolutions += 1;
        return null;
      },
    });

    await service.listPullRequests({ cwd: "/repo", query: "one", limit: 1 });
    await service.listPullRequests({ cwd: "/repo", query: "two", limit: 1 });

    expect(hostResolutions).toBe(1);
    expect(runner.calls.every((call) => call.envOverlay?.GH_HOST === undefined)).toBe(true);
  });

  it("re-resolves a null repo host after the TTL expires", async () => {
    const runner = createRunner(["[]", "[]"]);
    let hostResolutions = 0;
    let nowMs = 0;
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      now: () => nowMs,
      resolveRepoHost: async () => {
        hostResolutions += 1;
        return hostResolutions === 1 ? null : "ghe.example.com";
      },
    });

    await service.listPullRequests({ cwd: "/repo", query: "one", limit: 1 });
    expect(runner.calls[0]?.envOverlay?.GH_HOST).toBeUndefined();

    nowMs = 60_001;
    await service.listPullRequests({ cwd: "/repo", query: "two", limit: 1 });

    expect(hostResolutions).toBe(2);
    expect(runner.calls[1]?.envOverlay).toMatchObject({ GH_HOST: "ghe.example.com" });
  });

  it("re-resolves the host after invalidation when the remote changes", async () => {
    const runner = createRunner([]);
    let hostCall = 0;
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
      resolveRepoHost: async () => (hostCall++ === 0 ? "host-a.internal" : "host-b.internal"),
    });

    await service.listPullRequests({ cwd: "/repo", query: "x", limit: 1 });
    expect(runner.calls[0]?.envOverlay).toMatchObject({ GH_HOST: "host-a.internal" });

    service.invalidate({ cwd: "/repo" });

    await service.listPullRequests({ cwd: "/repo", query: "x", limit: 1 });
    expect(runner.calls[1]?.envOverlay).toMatchObject({ GH_HOST: "host-b.internal" });
  });

  it("throws when the workspace repository cannot be resolved for pull request creation", async () => {
    const runner = createRunner([JSON.stringify({})]);
    const service = createGitHubService({ runner: runner.runner });

    await expect(
      service.createPullRequest({
        cwd: "/tmp/repo",
        title: "Add thing",
        head: "feature",
        base: "main",
      }),
    ).rejects.toThrow("Unable to resolve GitHub repository for pull request creation");
  });
});
