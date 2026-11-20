import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeRequestSnapshot } from "./change-request-source.js";
import {
  describeGitLabChangeRequest,
  gitlabChangeRequestHost,
  resolveGitLabChangeRequest,
} from "./gitlab-change-requests.js";
import { createGitLabService, type GlabCommandRunner } from "./gitlab-service.js";

function httpJson(
  body: unknown,
  headers: Record<string, string> = {},
  status = "200 OK",
): { stdout: string; stderr: string } {
  const lines = [`HTTP/2.0 ${status}`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}: ${value}`);
  }
  return {
    stdout: `${lines.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`,
    stderr: "",
  };
}

function createFakeGlabRunner(
  handler: (
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
) {
  const calls: Array<{ args: string[]; cwd: string; envOverlay?: Record<string, string> }> = [];
  const runner: GlabCommandRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd, envOverlay: options.envOverlay });
    return await handler(args, options);
  };
  return { runner, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GitLab change request URL resolution and description", () => {
  it("canonicalizes standard, nested-group, legacy, tab, query, and hash URLs while preserving path casing", () => {
    expect(
      resolveGitLabChangeRequest(
        "https://GitLab.com/MyOrg/SubGroup/MyRepo/-/merge_requests/042/diffs?view=inline#note_9",
      ),
    ).toBe("https://gitlab.com/MyOrg/SubGroup/MyRepo/-/merge_requests/42");

    expect(
      resolveGitLabChangeRequest("https://gitlab.com/Team/App/merge_requests/7/pipelines/"),
    ).toBe("https://gitlab.com/Team/App/-/merge_requests/7");

    expect(
      resolveGitLabChangeRequest(
        "https://GitLab.Example.Internal:8443/Group/Sub/Repo/-/merge_requests/12/commits",
      ),
    ).toBe("https://gitlab.example.internal:8443/Group/Sub/Repo/-/merge_requests/12");

    expect(resolveGitLabChangeRequest("http://gitlab.lan/Group/Repo/-/merge_requests/3")).toBe(
      "http://gitlab.lan/Group/Repo/-/merge_requests/3",
    );
  });

  it("describes cloud and self-hosted GitLab MRs with native !N numbering", () => {
    expect(
      describeGitLabChangeRequest("https://gitlab.com/MyOrg/SubGroup/MyRepo/-/merge_requests/42"),
    ).toBe("MyOrg/SubGroup/MyRepo !42");
    expect(
      describeGitLabChangeRequest(
        "https://gitlab.example.internal:8443/Group/Repo/-/merge_requests/12",
      ),
    ).toBe("gitlab.example.internal:8443/Group/Repo !12");
    expect(
      gitlabChangeRequestHost(
        "https://gitlab.example.internal:8443/Group/Repo/-/merge_requests/12",
      ),
    ).toBe("gitlab.example.internal:8443");
  });

  it("rejects invalid GitLab MR URLs", () => {
    for (const invalid of [
      "https://gitlab.com/only-one-segment/-/merge_requests/1",
      "https://gitlab.com/org/repo/-/issues/1",
      "https://gitlab.com/org/repo/-/merge_requests/0",
      "https://gitlab.com/org/repo/-/merge_requests/abc",
      "https://gitlab.com/org/../repo/-/merge_requests/1",
      "https://gitlab.com/org/repo/-/merge_requests/1/unknown-tab",
      "http://gitlab.com/org/repo/-/merge_requests/1",
      "https://gitlab.com/org/repo/-/something/merge_requests/1",
    ]) {
      expect(() => resolveGitLabChangeRequest(invalid), invalid).toThrow(
        /GitLab merge request URL/i,
      );
    }
  });
});

describe("GitLab ChangeRequestSource polling", () => {
  it("uses cwd-free glab api --hostname, maps head-pipeline jobs, discussions, and approval transitions without reviewDecision", async () => {
    vi.useFakeTimers();
    let poll = 0;
    const mrUrl = "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/merge_requests/42";
    const encodedProject = encodeURIComponent("MyOrg/SubGroup/MyRepo");

    const { runner, calls } = createFakeGlabRunner((args) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encodedProject}/merge_requests/42`) {
        poll += 1;
        return httpJson({
          iid: 42,
          state: "opened",
          sha: "sha-1",
          web_url: mrUrl,
          target_project_id: 900,
          head_pipeline: {
            id: 500,
            project_id: 901,
            sha: "merge-sha-1",
            status: poll === 1 ? "running" : "success",
            web_url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/pipelines/500",
          },
        });
      }
      if (endpoint.startsWith("projects/901/pipelines/500/jobs")) {
        return httpJson(
          [
            {
              id: 10,
              name: "lint",
              stage: "test",
              status: "failed",
              allow_failure: true,
              web_url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/10",
            },
            {
              id: 11,
              name: "unit",
              stage: "test",
              status: poll === 1 ? "running" : "success",
              allow_failure: false,
              web_url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/11",
            },
            {
              id: 12,
              name: "deploy",
              stage: "deploy",
              status: "manual",
              allow_failure: true,
              web_url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/12",
            },
          ],
          { "X-Next-Page": "" },
        );
      }
      if (endpoint.startsWith(`projects/${encodedProject}/merge_requests/42/discussions`)) {
        const notes =
          poll === 1
            ? [
                {
                  id: 100,
                  system: false,
                  body: "Initial comment",
                  author: { username: "bob" },
                },
                {
                  id: 101,
                  system: false,
                  type: "DiffNote",
                  body: "Inline note",
                  position: { new_path: "src/app.ts", new_line: 10 },
                  author: { username: "bob" },
                },
                {
                  id: 102,
                  system: true,
                  body: "assigned to @bob",
                  author: { username: "bob" },
                },
              ]
            : [
                {
                  id: 100,
                  system: false,
                  body: "Initial comment",
                  author: { username: "bob" },
                },
                {
                  id: 101,
                  system: false,
                  type: "DiffNote",
                  body: "Inline note",
                  position: { new_path: "src/app.ts", new_line: 10 },
                  author: { username: "bob" },
                },
                {
                  id: 103,
                  system: true,
                  body: "approved this merge request",
                  author: { username: "alice" },
                },
              ];
        return httpJson([{ id: "disc-1", notes }], { "X-Next-Page": "" });
      }
      if (endpoint === `projects/${encodedProject}/merge_requests/42/approvals`) {
        return httpJson(
          poll === 1
            ? { approvals_required: 1, approvals_left: 1, approved: false, approved_by: [] }
            : {
                approvals_required: 1,
                approvals_left: 0,
                approved: true,
                approved_by: [
                  { user: { id: 1, username: "alice" }, approved_at: "2026-11-20T06:00:00Z" },
                ],
              },
        );
      }
      throw new Error(`Unexpected glab args: ${args.join(" ")}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      resolveRemoteUrl: async () => {
        throw new Error("watch must not inspect local git remote");
      },
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    const seen = new Set<string>();
    try {
      const release = service.changeRequests!.observe(mrUrl, {
        knownActivity: () => seen,
        async snapshot(s) {
          snapshots.push(s);
          for (const item of s.activity) seen.add(item.id);
        },
        error(err) {
          errors.push(err);
        },
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual({
        state: "open",
        headSha: "sha-1",
        checksState: "pending",
        checks: [
          {
            id: "job:10",
            name: "lint",
            state: "neutral",
            url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/10",
          },
          {
            id: "job:11",
            name: "unit",
            state: "pending",
            url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/11",
          },
          {
            id: "job:12",
            name: "deploy",
            state: "neutral",
            url: "https://gitlab.com/MyOrg/SubGroup/MyRepo/-/jobs/12",
          },
        ],
        reviewDecision: null,
        activity: [
          { id: "comment:100", kind: "comment", url: `${mrUrl}#note_100` },
          { id: "inline:101", kind: "inline comment", url: `${mrUrl}#note_101` },
        ],
      });
      // Every glab api call targets --hostname gitlab.com explicitly.
      for (const call of calls) {
        expect(call.args.slice(0, 4)).toEqual(["api", "--hostname", "gitlab.com", "-i"]);
      }

      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toEqual([]);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]!.checksState).toBe("passed");
      expect(snapshots[1]!.reviewDecision).toBeNull();
      const approvalEvents = snapshots[1]!.activity.filter((a) => a.kind === "approval");
      expect(approvalEvents).toEqual([
        {
          id: "approval-note:103",
          kind: "approval",
          url: `${mrUrl}#note_103`,
          message: `Merge request approved by @alice (1/1 approvals): ${mrUrl}#note_103`,
        },
      ]);
      release();
    } finally {
      service.dispose?.();
    }
  });

  it("detects approval transitions from /approvals when no system note is present", async () => {
    vi.useFakeTimers();
    let poll = 0;
    const mrUrl = "https://gitlab.com/org/repo/-/merge_requests/5";
    const encoded = encodeURIComponent("org/repo");

    const { runner } = createFakeGlabRunner((args) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encoded}/merge_requests/5`) {
        poll += 1;
        return httpJson({
          iid: 5,
          state: "opened",
          sha: "abc",
          web_url: mrUrl,
          head_pipeline: null,
        });
      }
      if (endpoint.startsWith(`projects/${encoded}/merge_requests/5/discussions`)) {
        return httpJson([], { "X-Next-Page": "" });
      }
      if (endpoint === `projects/${encoded}/merge_requests/5/approvals`) {
        if (poll === 1) {
          return httpJson({
            approvals_required: 1,
            approvals_left: 1,
            approved: false,
            approved_by: [],
          });
        }
        if (poll === 2) {
          return httpJson({
            approvals_required: 1,
            approvals_left: 0,
            approved: true,
            approved_by: [
              { user: { id: 2, username: "carol" }, approved_at: "2026-11-20T07:00:00Z" },
            ],
          });
        }
        return httpJson({
          approvals_required: 1,
          approvals_left: 1,
          approved: false,
          approved_by: [],
        });
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(mrUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          throw err;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots[0]!.activity).toEqual([]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots[1]!.activity).toEqual([
        expect.objectContaining({
          kind: "approval",
          message: `Merge request approved by @carol (1/1 approvals): ${mrUrl}`,
        }),
      ]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots[2]!.activity).toEqual([
        expect.objectContaining({
          kind: "approval",
          message: `Merge request approval removed by @carol (0/1 approvals): ${mrUrl}`,
        }),
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("paginates jobs and discussions, rejects mid-pagination headSha changes, and treats partial errors as stale", async () => {
    vi.useFakeTimers();
    let mrReads = 0;
    let discussionPage2Fails = true;
    const mrUrl = "https://gitlab.com/org/repo/-/merge_requests/8";
    const encoded = encodeURIComponent("org/repo");

    const { runner } = createFakeGlabRunner((args) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encoded}/merge_requests/8`) {
        mrReads += 1;
        // 1st poll: headSha changes mid-pagination (read 1 -> sha-1, recheck read 2 -> sha-2)
        if (mrReads === 1) {
          return httpJson({
            iid: 8,
            state: "opened",
            sha: "sha-1",
            web_url: mrUrl,
            target_project_id: 1,
            head_pipeline: { id: 20, project_id: 1, status: "running" },
          });
        }
        return httpJson({
          iid: 8,
          state: "opened",
          sha: "sha-2",
          web_url: mrUrl,
          target_project_id: 1,
          head_pipeline: { id: 21, project_id: 1, status: "failed" },
        });
      }
      if (endpoint.includes("/pipelines/20/jobs") && endpoint.endsWith("&page=1")) {
        return httpJson(
          [{ id: 1, name: "j1", stage: "test", status: "running", allow_failure: false }],
          { "X-Next-Page": "2" },
        );
      }
      if (endpoint.includes("/pipelines/20/jobs") && endpoint.endsWith("&page=2")) {
        return httpJson(
          [{ id: 2, name: "j2", stage: "test", status: "success", allow_failure: false }],
          { "X-Next-Page": "" },
        );
      }
      if (endpoint.includes("/pipelines/21/jobs")) {
        return httpJson(
          [{ id: 3, name: "j3", stage: "test", status: "failed", allow_failure: false }],
          { "X-Next-Page": "" },
        );
      }
      if (endpoint.includes("/discussions") && endpoint.endsWith("&page=1")) {
        return httpJson([{ id: "d1", notes: [{ id: 1, system: false, body: "p1" }] }], {
          "X-Next-Page": "2",
        });
      }
      if (endpoint.includes("/discussions") && endpoint.endsWith("&page=2")) {
        if (discussionPage2Fails) {
          discussionPage2Fails = false;
          throw Object.assign(new Error("500"), { code: 1, stderr: "500 Internal Server Error" });
        }
        return httpJson([{ id: "d2", notes: [{ id: 2, system: false, body: "p2" }] }], {
          "X-Next-Page": "",
        });
      }
      if (endpoint.endsWith("/approvals")) {
        return httpJson({ approvals_required: 0, approvals_left: 0, approved_by: [] });
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: Error[] = [];
    try {
      service.changeRequests!.observe(mrUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err as Error);
        },
      });

      // Poll 1 fails because headSha changed during multi-page job pagination
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/changed during pagination/i);

      // Poll 2 (after 10s backoff) fails because discussion page 2 returns 500 — must NOT emit partial snapshot
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toHaveLength(0);
      expect(errors).toHaveLength(2);

      // Poll 3 (after 20s exponential backoff) succeeds with complete paginated discussions and failed check
      await vi.advanceTimersByTimeAsync(20_000);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        headSha: "sha-2",
        checksState: "failed",
        checks: [{ id: "job:3", name: "j3", state: "failed" }],
        activity: [
          { id: "comment:1", kind: "comment", url: `${mrUrl}#note_1` },
          { id: "comment:2", kind: "comment", url: `${mrUrl}#note_2` },
        ],
      });
    } finally {
      service.dispose?.();
    }
  });

  it("verifies self-hosted auth once, honors 429 Retry-After, and skips remaining pages on release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const mrUrl = "https://git.corp.internal/team/app/-/merge_requests/3";
    const encoded = encodeURIComponent("team/app");
    let authChecks = 0;
    let mrCalls = 0;

    const { runner } = createFakeGlabRunner((args) => {
      if (args[0] === "auth" && args[1] === "status") {
        authChecks += 1;
        return { stdout: "Logged in", stderr: "" };
      }
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encoded}/merge_requests/3`) {
        mrCalls += 1;
        if (mrCalls === 1) {
          throw Object.assign(new Error("429"), {
            code: 1,
            stdout:
              'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 45\r\n\r\n{"message":"Too many requests"}',
            stderr: "429 Too Many Requests",
          });
        }
        return httpJson({
          iid: 3,
          state: "opened",
          sha: "xyz",
          web_url: mrUrl,
          head_pipeline: null,
        });
      }
      if (endpoint.includes("/discussions")) {
        return httpJson([], { "X-Next-Page": "" });
      }
      if (endpoint.endsWith("/approvals")) {
        throw Object.assign(new Error("404"), { code: 1, stderr: "404 Not Found" });
      }
      throw new Error(`Unexpected: ${args.join(" ")}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      const release = service.changeRequests!.observe(mrUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(authChecks).toBe(1);
      expect(mrCalls).toBe(1);
      expect(errors).toHaveLength(1);

      // Still paused before 45s Retry-After expires
      await vi.advanceTimersByTimeAsync(44_999);
      expect(mrCalls).toBe(1);

      // Resumes at 45s without re-running auth status, and tolerates 404 on /approvals (CE)
      await vi.advanceTimersByTimeAsync(1);
      expect(authChecks).toBe(1);
      expect(mrCalls).toBe(2);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.headSha).toBe("xyz");
      release();
    } finally {
      service.dispose?.();
    }
  });

  it("stops paginating immediately when released mid-read and surfaces failed bridge jobs", async () => {
    vi.useFakeTimers();
    const mrUrl = "https://gitlab.com/org/repo/-/merge_requests/15";
    const encoded = encodeURIComponent("org/repo");
    let releaseFirstPage!: () => void;
    let discussionPage2Called = false;

    const { runner } = createFakeGlabRunner(async (args) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encoded}/merge_requests/15`) {
        return httpJson({
          iid: 15,
          state: "opened",
          sha: "sha-bridge",
          web_url: mrUrl,
          target_project_id: 7,
          head_pipeline: {
            id: 88,
            project_id: 7,
            status: "failed",
            web_url: "https://gitlab.com/org/repo/-/pipelines/88",
          },
        });
      }
      if (endpoint.includes("/pipelines/88/jobs")) {
        return httpJson(
          [{ id: 1, name: "prepare", stage: "prep", status: "success", allow_failure: false }],
          { "X-Next-Page": "" },
        );
      }
      if (endpoint.includes("/pipelines/88/bridges")) {
        return httpJson(
          [
            {
              id: 2,
              name: "downstream-e2e",
              stage: "trigger",
              status: "failed",
              allow_failure: false,
              web_url: "https://gitlab.com/org/repo/-/jobs/2",
            },
          ],
          { "X-Next-Page": "" },
        );
      }
      if (endpoint.includes("/discussions") && endpoint.endsWith("&page=1")) {
        await new Promise<void>((resolve) => {
          releaseFirstPage = resolve;
        });
        return httpJson([{ id: "d1", notes: [{ id: 10, system: false, body: "hi" }] }], {
          "X-Next-Page": "2",
        });
      }
      if (endpoint.includes("/discussions") && endpoint.endsWith("&page=2")) {
        discussionPage2Called = true;
        return httpJson([], { "X-Next-Page": "" });
      }
      if (endpoint.endsWith("/approvals")) {
        return httpJson({ approvals_required: 0, approvals_left: 0, approved_by: [] });
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      const release = service.changeRequests!.observe(mrUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(releaseFirstPage).toBeTypeOf("function"));
      release();
      releaseFirstPage();
      await vi.advanceTimersByTimeAsync(0);
      expect(discussionPage2Called).toBe(false);
      expect(snapshots).toEqual([]);
      expect(errors).toEqual([]);

      // Re-observe without releasing early to verify failed bridge check is surfaced.
      service.changeRequests!.observe(mrUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(() => expect(releaseFirstPage).toBeTypeOf("function"));
      releaseFirstPage();
      await vi.advanceTimersByTimeAsync(0);
      expect(discussionPage2Called).toBe(true);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.checks).toContainEqual({
        id: "bridge:2",
        name: "downstream-e2e",
        state: "failed",
        url: "https://gitlab.com/org/repo/-/jobs/2",
      });
    } finally {
      service.dispose?.();
    }
  });
});
