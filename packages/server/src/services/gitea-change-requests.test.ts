import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentMessageDelivery } from "../server/agent/agent-messages/index.js";
import { AgentBackgroundWorkStore } from "../server/agent/background-work/index.js";
import { createChangeRequestWatches } from "../server/agent/change-request-watches/index.js";
import { createChangeRequestRouter } from "./change-request-router.js";
import type { ChangeRequestSnapshot } from "./change-request-source.js";
import { createForgeResolver } from "./forge-resolver.js";
import {
  describeGiteaChangeRequest,
  giteaChangeRequestHost,
  resolveGiteaChangeRequest,
} from "./gitea-change-requests.js";
import {
  createGiteaService,
  TeaAuthenticationError,
  type TeaCommandRunner,
} from "./gitea-service.js";

const PR2_WORKDIR_NOTE = "cwd-free";

function teaHttp(
  body: unknown,
  options: { status?: string; headers?: Record<string, string>; headersOnStderr?: boolean } = {},
): { stdout: string; stderr: string } {
  const lines = [`HTTP/1.1 ${options.status ?? "200 OK"}`];
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  const headerBlock = `${lines.join("\r\n")}\r\n\r\n`;
  const json = typeof body === "string" ? body : JSON.stringify(body);
  if (options.headersOnStderr) {
    return { stdout: json, stderr: headerBlock };
  }
  return { stdout: `${headerBlock}${json}`, stderr: "" };
}

function createFakeTeaRunner(
  handler: (
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: TeaCommandRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd });
    return await handler(args, options);
  };
  return { runner, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Gitea-family change request URL resolution and description", () => {
  it("canonicalizes Gitea, Codeberg, and self-hosted Forgejo PR URLs across tabs, queries, and ports", () => {
    expect(
      resolveGiteaChangeRequest("https://Codeberg.org/Org/Repo/pulls/042/files?style=split#diff-1"),
    ).toBe("https://codeberg.org/Org/Repo/pulls/42");
    expect(resolveGiteaChangeRequest("https://gitea.com/Alice/App/pulls/7/commits/")).toBe(
      "https://gitea.com/Alice/App/pulls/7",
    );
    expect(
      resolveGiteaChangeRequest("https://Forgejo.Example.Org:3000/Team/Tool/pulls/9/checks"),
    ).toBe("https://forgejo.example.org:3000/Team/Tool/pulls/9");
    expect(resolveGiteaChangeRequest("http://gitea.lan:3000/Team/Tool/pulls/3")).toBe(
      "http://gitea.lan:3000/Team/Tool/pulls/3",
    );
  });

  it("describes cloud and self-hosted PRs with native #N numbering and host when non-default", () => {
    expect(describeGiteaChangeRequest("https://codeberg.org/Org/Repo/pulls/42")).toBe(
      "Org/Repo #42",
    );
    expect(describeGiteaChangeRequest("https://gitea.com/Alice/App/pulls/7")).toBe("Alice/App #7");
    expect(describeGiteaChangeRequest("https://forgejo.example.org:3000/Team/Tool/pulls/9")).toBe(
      "forgejo.example.org:3000/Team/Tool #9",
    );
    expect(giteaChangeRequestHost("https://forgejo.example.org:3000/Team/Tool/pulls/9")).toBe(
      "forgejo.example.org:3000",
    );
  });

  it("rejects invalid Gitea-family PR URLs", () => {
    for (const invalid of [
      "https://codeberg.org/Org/Repo/pull/42",
      "https://codeberg.org/Org/Repo/issues/42",
      "https://codeberg.org/Org/Sub/Repo/pulls/42",
      "https://codeberg.org/Org/Repo/pulls/0",
      "https://codeberg.org/Org/../pulls/42",
      "https://codeberg.org/Org/Repo/pulls/42/unknown",
      "http://codeberg.org/Org/Repo/pulls/42",
      "http://gitea.com/Org/Repo/pulls/42",
    ]) {
      expect(() => resolveGiteaChangeRequest(invalid), invalid).toThrow(/pull request URL/i);
    }
  });
});

describe("Gitea-family ChangeRequestSource polling", () => {
  it("uses cwd-free tea login list + tea api --login -i, combines statuses + Actions tasks + approval-held runs, and namespaces comments/reviews/inline", async () => {
    vi.useFakeTimers();
    const prUrl = "https://codeberg.org/Alice/App/pulls/12";
    const headSha = "sha-111";
    let loginListCalls = 0;

    const { runner, calls } = createFakeTeaRunner((args) => {
      if (args[0] === "login" && args[1] === "list") {
        loginListCalls += 1;
        return {
          stdout: JSON.stringify([
            { name: "cb-login", url: "https://codeberg.org", ssh_host: "codeberg.org" },
          ]),
          stderr: "",
        };
      }
      expect(args.slice(0, 4)).toEqual(["api", "--login", "cb-login", "-i"]);
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Alice/App/pulls/12") {
        return teaHttp({
          number: 12,
          state: "open",
          merged: false,
          html_url: prUrl,
          head: { sha: headSha },
        });
      }
      if (endpoint.startsWith(`repos/Alice/App/commits/${headSha}/status`)) {
        return teaHttp(
          {
            state: "pending",
            total_count: 3,
            statuses: [
              // Native shadow for run 100 job 501 — must be deduplicated against action task 501
              {
                id: 1,
                status: "success",
                context: "CI / build",
                target_url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
              },
              // Uncovered pending shadow for cross-repo approval-held run 101
              {
                id: 2,
                status: "pending",
                context: "CI / fork-e2e",
                target_url: "https://codeberg.org/Alice/App/actions/runs/101/jobs/502",
              },
              // External status with warning -> non-passing failure
              {
                id: 3,
                status: "warning",
                context: "external/lint",
                target_url: "https://ci.example.com/build/3",
              },
            ],
          },
          { headersOnStderr: true },
        );
      }
      if (endpoint.startsWith("repos/Alice/App/actions/tasks")) {
        return teaHttp({
          total_count: 2,
          workflow_runs: [
            // Older rerun of build workflow — must be collapsed
            {
              id: 500,
              name: "build",
              head_sha: headSha,
              run_number: 1,
              workflow_id: "ci.yml",
              status: "failure",
              url: "https://codeberg.org/Alice/App/actions/runs/99/jobs/500",
            },
            // Latest rerun of build workflow — passed
            {
              id: 501,
              name: "build",
              head_sha: headSha,
              run_number: 2,
              workflow_id: "ci.yml",
              status: "success",
              url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
            },
          ],
        });
      }
      if (endpoint.startsWith("repos/Alice/App/actions/runs")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 101,
              head_sha: headSha,
              status: "waiting",
              need_approval: false,
              pull_requests: [{ head: { repo: { id: 999 } }, base: { repo: { id: 1 } } }],
            },
          ],
        });
      }
      if (endpoint.startsWith("repos/Alice/App/issues/12/comments")) {
        return teaHttp([
          { id: 10, type: "comment", html_url: `${prUrl}#issuecomment-10`, body: "Looks good" },
          { id: 11, type: "label", html_url: `${prUrl}#issuecomment-11`, body: "" },
        ]);
      }
      if (endpoint.startsWith("repos/Alice/App/pulls/12/reviews?")) {
        return teaHttp([
          {
            id: 20,
            state: "APPROVED",
            comments_count: 1,
            submitted_at: "2026-11-20T06:00:00Z",
            html_url: `${prUrl}#pullrequestreview-20`,
          },
          {
            id: 21,
            state: "PENDING",
            comments_count: 2,
            html_url: `${prUrl}#pullrequestreview-21`,
          },
          {
            id: 22,
            state: "REQUEST_REVIEW",
            comments_count: 0,
            html_url: `${prUrl}#pullrequestreview-22`,
          },
        ]);
      }
      if (endpoint.startsWith("repos/Alice/App/pulls/12/reviews/20/comments")) {
        return teaHttp([
          {
            id: 10, // Same numeric id as issue comment 10 — must NOT collide!
            html_url: `${prUrl}#issuecomment-999`,
            body: "Nit here",
          },
        ]);
      }
      throw new Error(`Unexpected tea endpoint (${PR2_WORKDIR_NOTE}): ${endpoint}`);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      resolveRemoteUrl: async () => {
        throw new Error("watch must not inspect local git remote");
      },
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      const release = service.changeRequests!.observe(prUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([]);
      expect(loginListCalls).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual({
        state: "open",
        headSha,
        checksState: "failed",
        checks: [
          {
            id: "status:2",
            name: "CI / fork-e2e",
            state: "pending",
            url: "https://codeberg.org/Alice/App/actions/runs/101/jobs/502",
          },
          {
            id: "status:3",
            name: "external/lint",
            state: "failed",
            url: "https://ci.example.com/build/3",
          },
          {
            id: "action:501",
            name: "build",
            state: "passed",
            url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
          },
        ],
        reviewDecision: null,
        activity: [
          { id: "comment:10", kind: "comment", url: `${prUrl}#issuecomment-10` },
          { id: "review:20", kind: "review", url: `${prUrl}#pullrequestreview-20` },
          { id: "inline:10", kind: "inline comment", url: `${prUrl}#issuecomment-999` },
        ],
      });
      expect(calls.some((c) => c.args.includes("reviews/21/comments"))).toBe(false);
      release();
    } finally {
      service.dispose?.();
    }
  });

  it("inspects HTTP status codes directly instead of trusting exit code 0 (500, 401, 429, missing status)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const prUrl = "https://gitea.com/Org/Repo/pulls/5";
    let step = 0;
    let loginLists = 0;

    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        loginLists += 1;
        return {
          stdout: JSON.stringify([{ name: "gitea-main", url: "https://gitea.com" }]),
          stderr: "",
        };
      }
      step += 1;
      // Step 1: exit 0 with HTTP 500 on stdout -> must fail poll
      if (step === 1) {
        return teaHttp({ message: "boom" }, { status: "500 Internal Server Error" });
      }
      // Step 2: exit 0 with NO HTTP status line -> must fail poll
      if (step === 2) {
        return { stdout: JSON.stringify({ number: 5 }), stderr: "" };
      }
      // Step 3: exit 0 with HTTP 401 on stderr -> TeaAuthenticationError + invalidates login cache
      if (step === 3) {
        return teaHttp(
          { message: "token expired" },
          { status: "401 Unauthorized", headersOnStderr: true },
        );
      }
      // Step 4: exit 0 with HTTP 429 + Retry-After: 50 -> pauses host for 50s
      if (step === 4) {
        return teaHttp(
          { message: "slow down" },
          { status: "429 Too Many Requests", headers: { "Retry-After": "50" } },
        );
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Org/Repo/pulls/5") {
        return teaHttp({
          number: 5,
          state: "open",
          merged: false,
          html_url: prUrl,
          head: { sha: "ok" },
        });
      }
      if (endpoint.includes("/status")) {
        return teaHttp({ state: "", statuses: [], total_count: 0 });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({ message: "Not Found" }, { status: "404 Not Found" });
      }
      return teaHttp([]);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const errors: unknown[] = [];
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(prUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });

      // Step 1: HTTP 500 (exit 0)
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toHaveLength(1);
      expect(snapshots).toHaveLength(0);

      // Step 2: Missing HTTP status line (after 10s backoff)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toHaveLength(2);

      // Step 3: HTTP 401 (after 20s backoff) -> clears cached login
      await vi.advanceTimersByTimeAsync(20_000);
      expect(errors).toHaveLength(3);
      expect(errors[2]).toBeInstanceOf(TeaAuthenticationError);
      expect(loginLists).toBe(1);

      // Step 4: HTTP 429 (after 40s backoff) -> re-resolves login list and pauses host 50s
      await vi.advanceTimersByTimeAsync(40_000);
      expect(errors).toHaveLength(4);
      expect(loginLists).toBe(2);

      // Still paused at 49.999s
      await vi.advanceTimersByTimeAsync(49_999);
      expect(snapshots).toHaveLength(0);

      // Resumes at 50s and succeeds (tolerating 404 on /actions/tasks)
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.headSha).toBe("ok");
    } finally {
      service.dispose?.();
    }
  });

  it("bounds review-comment fan-out, skips unchanged reviews on quiet polls, rejects mid-pagination headSha changes, and treats partial failures as stale", async () => {
    vi.useFakeTimers();
    const prUrl = "https://forgejo.example.org/Team/Core/pulls/4";
    let prReads = 0;
    let activeReviewFetches = 0;
    let maxReviewFetches = 0;
    let reviewCommentCalls = 0;
    let failReview3 = true;

    const { runner } = createFakeTeaRunner(async (args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "fj", url: "https://forgejo.example.org" }]),
          stderr: "",
        };
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Team/Core/pulls/4") {
        prReads += 1;
        // Poll 1: headSha shifts mid-pagination (read 1 -> sha-a, recheck read 2 -> sha-b)
        const sha = prReads === 1 ? "sha-a" : "sha-b";
        return teaHttp({ number: 4, state: "open", merged: false, html_url: prUrl, head: { sha } });
      }
      if (endpoint.includes("/commits/sha-a/status") && endpoint.includes("page=1")) {
        return teaHttp({
          state: "pending",
          total_count: 2,
          statuses: [{ id: 1, status: "pending", context: "c1" }],
        });
      }
      if (endpoint.includes("/commits/sha-a/status") && endpoint.includes("page=2")) {
        return teaHttp({
          state: "pending",
          total_count: 2,
          statuses: [{ id: 2, status: "success", context: "c2" }],
        });
      }
      if (endpoint.includes("/commits/sha-b/status")) {
        return teaHttp({ state: "success", total_count: 0, statuses: [] });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({ total_count: 0, workflow_runs: [] });
      }
      if (endpoint.includes("/issues/4/comments")) {
        return teaHttp([]);
      }
      if (endpoint.includes("/pulls/4/reviews?")) {
        const reviews = [];
        for (let id = 1; id <= 5; id += 1) {
          reviews.push({
            id,
            state: "COMMENT",
            comments_count: 1,
            submitted_at: "2026-11-20T06:00:00Z",
            html_url: `${prUrl}#pullrequestreview-${id}`,
          });
        }
        return teaHttp(reviews);
      }
      const reviewMatch = /\/pulls\/4\/reviews\/(\d+)\/comments/.exec(endpoint);
      if (reviewMatch) {
        const reviewId = Number(reviewMatch[1]);
        reviewCommentCalls += 1;
        activeReviewFetches += 1;
        maxReviewFetches = Math.max(maxReviewFetches, activeReviewFetches);
        await Promise.resolve();
        activeReviewFetches -= 1;
        if (reviewId === 3 && failReview3) {
          failReview3 = false;
          return teaHttp({ message: "502" }, { status: "502 Bad Gateway" });
        }
        return teaHttp([
          { id: reviewId * 100, html_url: `${prUrl}#issuecomment-${reviewId * 100}` },
        ]);
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: Error[] = [];
    const seen = new Set<string>();
    try {
      service.changeRequests!.observe(prUrl, {
        knownActivity: () => seen,
        async snapshot(s) {
          snapshots.push(s);
          for (const a of s.activity) seen.add(a.id);
        },
        error(err) {
          errors.push(err as Error);
        },
      });

      // Poll 1: fails due to mid-pagination headSha change
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toHaveLength(0);
      expect(errors[0]?.message).toMatch(/changed during pagination/i);

      // Poll 2: review 3 comments returns 502 -> entire poll fails (no partial seenActivity committed)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toHaveLength(0);
      expect(errors).toHaveLength(2);

      // Poll 3: succeeds with bounded review-comment fan-out (<= 3 concurrent)
      await vi.advanceTimersByTimeAsync(20_000);
      expect(snapshots).toHaveLength(1);
      expect(maxReviewFetches).toBeLessThanOrEqual(3);
      expect(snapshots[0]!.activity.filter((a) => a.kind === "inline comment")).toHaveLength(5);
      const callsAfterBaseline = reviewCommentCalls;

      // Poll 4 (quiet): unchanged reviews are skipped — zero additional review-comment fetches
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toHaveLength(2);
      expect(reviewCommentCalls).toBe(callsAfterBaseline);
    } finally {
      service.dispose?.();
    }
  });

  it("routes gitea.com, codeberg.org, and probed self-hosted forgejo through ChangeRequestRouter", async () => {
    const forgeResolver = createForgeResolver({
      probeForge: async (host) => (host === "forgejo.internal" ? "forgejo" : null),
    });
    const router = createChangeRequestRouter({ forgeResolver });
    try {
      await expect(router.resolve("https://gitea.com/Org/Repo/pulls/3")).resolves.toEqual({
        forge: "gitea",
        url: "https://gitea.com/Org/Repo/pulls/3",
      });
      await expect(router.resolve("https://codeberg.org/Org/Repo/pulls/4/files")).resolves.toEqual({
        forge: "codeberg",
        url: "https://codeberg.org/Org/Repo/pulls/4",
      });
      await expect(
        router.resolve("https://forgejo.internal/Org/Repo/pulls/5/commits"),
      ).resolves.toEqual({
        forge: "forgejo",
        url: "https://forgejo.internal/Org/Repo/pulls/5",
      });
      expect(router.source("codeberg")?.describe("https://codeberg.org/Org/Repo/pulls/4")).toBe(
        "Org/Repo #4",
      );
      expect(router.source("forgejo")?.describe("https://forgejo.internal/Org/Repo/pulls/5")).toBe(
        "forgejo.internal/Org/Repo #5",
      );
    } finally {
      forgeResolver.dispose();
    }
  });

  it("keeps blocked need_approval Actions tasks pending and delivers digests across restart via ChangeRequestWatches", async () => {
    vi.useFakeTimers();
    const artifacts = join(import.meta.dirname, "../../../../.artifacts");
    await mkdir(artifacts, { recursive: true });
    const home = await mkdtemp(join(artifacts, "gitea-watch-"));
    const prUrl = "https://codeberg.org/Org/Repo/pulls/42";
    let phase = 1;

    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "cb", url: "https://codeberg.org" }]),
          stderr: "",
        };
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Org/Repo/pulls/42") {
        return teaHttp({
          number: 42,
          state: phase >= 3 ? "closed" : "open",
          merged: phase >= 3,
          html_url: prUrl,
          head: { sha: "sha-approval" },
        });
      }
      if (endpoint.includes("/commits/sha-approval/status")) {
        return teaHttp({ state: "", statuses: [], total_count: 0 });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 700,
              name: "ci",
              head_sha: "sha-approval",
              run_number: 1,
              workflow_id: "ci.yml",
              status: phase === 1 ? "blocked" : "success",
              url: "https://codeberg.org/Org/Repo/actions/runs/70/jobs/700",
            },
          ],
        });
      }
      if (endpoint.includes("/actions/runs")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 70,
              run_number: 1,
              head_sha: "sha-approval",
              status: "blocked",
              need_approval: true,
            },
          ],
        });
      }
      if (endpoint.includes("/issues/42/comments")) {
        return teaHttp([]);
      }
      if (endpoint.includes("/pulls/42/reviews?")) {
        return teaHttp(
          phase >= 2
            ? [
                {
                  id: 88,
                  state: "APPROVED",
                  comments_count: 1,
                  submitted_at: "2026-11-20T07:00:00Z",
                  html_url: `${prUrl}#pullrequestreview-88`,
                },
              ]
            : [],
        );
      }
      if (endpoint.includes("/pulls/42/reviews/88/comments")) {
        return teaHttp([{ id: 901, html_url: `${prUrl}#issuecomment-901` }]);
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const createWatchHarness = () => {
      const gitea = createGiteaService({
        runner,
        resolveTeaPath: async () => "tea",
        watchPollMs: 10_000,
      });
      const forgeResolver = createForgeResolver({
        createService: (forge) => (forge === "codeberg" ? gitea : null),
      });
      const backgroundWork = new AgentBackgroundWorkStore();
      const turns: Array<{ recipientId: string; prompt: string }> = [];
      const messages = createAgentMessageDelivery({
        isRunning: () => false,
        subscribe: () => () => {},
        async dispatch(request) {
          turns.push({ recipientId: request.recipientId, prompt: String(request.prompt) });
          return "turn_started";
        },
        onError(error) {
          throw error;
        },
      });
      const watches = createChangeRequestWatches({
        router: createChangeRequestRouter({ forgeResolver }),
        paseoHome: home,
        logger: pino({ enabled: false }),
        isActive: async () => true,
        messages: () => messages,
        backgroundWork,
      });
      return {
        watches,
        backgroundWork,
        turns,
        async close() {
          await watches.close();
          await messages.close();
          forgeResolver.dispose();
        },
      };
    };

    let harness = createWatchHarness();
    try {
      await harness.watches.start();
      const subPromise = harness.watches.subscribe("agent-1", `${prUrl}/files`);
      await vi.advanceTimersByTimeAsync(25);
      const sub = await subPromise;
      expect(sub).toMatchObject({
        url: prUrl,
        state: "open",
        headSha: "sha-approval",
        checksState: "pending",
        checks: [{ id: "action:700", name: "ci", state: "pending" }],
        subscribed: true,
        stale: false,
      });
      expect(harness.backgroundWork.list("agent-1")).toEqual([
        expect.objectContaining({ description: "Org/Repo #42", kind: "monitor" }),
      ]);
      const saved = JSON.parse(await readFile(join(home, "change-request-watches.json"), "utf8"));
      expect(saved).toEqual([expect.objectContaining({ forge: "codeberg", url: prUrl })]);

      // Restart daemon and verify watch restores and delivers passed checks + review + inline comment + merge
      await harness.close();
      phase = 2;
      harness = createWatchHarness();
      await harness.watches.start();
      expect(harness.backgroundWork.list("agent-1")).toEqual([
        expect.objectContaining({ description: "Org/Repo #42", kind: "monitor" }),
      ]);

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(async () => {
        const current = JSON.parse(
          await readFile(join(home, "change-request-watches.json"), "utf8"),
        ) as Array<{ seenActivity: string[] }>;
        expect(current[0]?.seenActivity).toContain("inline:901");
      });
      await vi.advanceTimersByTimeAsync(32_000);
      expect(harness.turns).toHaveLength(1);
      expect(harness.turns[0]!.prompt).toContain("Checks passed on sha-approval.");
      expect(harness.turns[0]!.prompt).toContain(`${prUrl}#pullrequestreview-88`);
      expect(harness.turns[0]!.prompt).toContain(`${prUrl}#issuecomment-901`);

      phase = 3;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(harness.backgroundWork.list("agent-1")).toEqual([]));
      await vi.advanceTimersByTimeAsync(32_000);
      expect(harness.turns).toHaveLength(2);
      expect(harness.turns[1]!.prompt).toContain("Change request merged.");
    } finally {
      await harness.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
