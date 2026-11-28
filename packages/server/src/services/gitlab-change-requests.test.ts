import { afterEach, describe, expect, it, vi } from "vitest";
import { createChangeRequestRouter } from "./change-request-router.js";
import type { ChangeRequestSnapshot } from "./change-request-source.js";
import { createForgeResolver } from "./forge-resolver.js";
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
                approvals_left: 1,
                approved: false,
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
          message: `Merge request approved by @alice (0/1 approvals): ${mrUrl}#note_103`,
        },
      ]);
      release();
    } finally {
      service.dispose?.();
    }
  });

  it("reports unapproval and approval-reset system notes and ignores 429/rate-limit text inside 200 OK payloads", async () => {
    vi.useFakeTimers();
    let poll = 0;
    const mrUrl = "https://gitlab.com/org/repo/-/merge_requests/429";
    const encoded = encodeURIComponent("org/repo");
    let approvalCalls = 0;

    const { runner } = createFakeGlabRunner((args) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === `projects/${encoded}/merge_requests/429`) {
        poll += 1;
        return httpJson({
          iid: 429,
          title: "Fix rate limit handling for HTTP 429 responses",
          description: "Too many requests should trigger backoff",
          state: "opened",
          sha: "abc",
          web_url: mrUrl,
          head_pipeline: null,
        });
      }
      if (endpoint.startsWith(`projects/${encoded}/merge_requests/429/discussions`)) {
        const notes: Array<{
          id: number;
          system: boolean;
          body: string;
          author: { username: string };
        }> = [
          {
            id: 1,
            system: false,
            body: "We hit HTTP 429 and rate limit errors in CI",
            author: { username: "dev" },
          },
        ];
        if (poll >= 2) {
          notes.push({
            id: 2,
            system: true,
            body: "unapproved this merge request",
            author: { username: "carol" },
          });
        }
        if (poll >= 3) {
          notes.push({
            id: 3,
            system: true,
            body: "reset approvals from @carol by pushing to the branch",
            author: { username: "dev" },
          });
        }
        return httpJson([{ id: "d1", notes }], { "X-Next-Page": "" });
      }
      if (endpoint === `projects/${encoded}/merge_requests/429/approvals`) {
        approvalCalls += 1;
        return httpJson({ approvals_required: 1, approvals_left: 1, approved_by: [] });
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const seen = new Set<string>();
    try {
      service.changeRequests!.observe(mrUrl, {
        knownActivity: () => seen,
        async snapshot(s) {
          snapshots.push(s);
          for (const item of s.activity) seen.add(item.id);
        },
        error(err) {
          throw err;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toHaveLength(1);
      expect(approvalCalls).toBe(0);
      expect(snapshots[0]!.activity).toEqual([
        { id: "comment:1", kind: "comment", url: `${mrUrl}#note_1` },
      ]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(approvalCalls).toBe(1);
      expect(snapshots[1]!.activity).toContainEqual({
        id: "approval-note:2",
        kind: "approval",
        url: `${mrUrl}#note_2`,
        message: `Merge request approval removed by @carol (0/1 approvals): ${mrUrl}#note_2`,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(approvalCalls).toBe(2);
      expect(snapshots[2]!.activity).toContainEqual({
        id: "approval-note:3",
        kind: "approval",
        url: `${mrUrl}#note_3`,
        message: `Merge request approvals reset by @dev (0/1 approvals): ${mrUrl}#note_3`,
      });
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

  it("honors a self-hosted rate limit before retrying the merge request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const mrUrl = "https://git.corp.internal/team/app/-/merge_requests/3";
    const encoded = encodeURIComponent("team/app");
    let mrCalls = 0;

    const { runner } = createFakeGlabRunner((args) => {
      if (args[0] === "auth" && args[1] === "status") {
        return { stdout: "Logged in", stderr: "" };
      }
      if (args[0] === "config") return { stdout: "", stderr: "" };
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
      expect(mrCalls).toBe(1);
      expect(errors).toHaveLength(1);

      // Still paused before 45s Retry-After expires
      await vi.advanceTimersByTimeAsync(44_999);
      expect(mrCalls).toBe(1);

      // Resumes when the server's Retry-After interval expires.
      await vi.advanceTimersByTimeAsync(1);
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

  it.each([
    { subfolder: "/apps/gitlab/", apiHost: "gitlab.example.org" },
    { subfolder: "", apiHost: "gitlab.example.org/apps/gitlab" },
  ])(
    "looks up the GitLab project with profile $subfolder $apiHost",
    async ({ subfolder, apiHost }) => {
      vi.useFakeTimers();
      const url = "https://gitlab.example.org/apps/gitlab/team/app/-/merge_requests/1";
      const { runner } = createFakeGlabRunner((args) => {
        if (args[0] === "auth") return { stdout: "Logged in", stderr: "" };
        if (args[0] === "config") {
          expect(args.slice(-2)).toEqual(["--host", "gitlab.example.org"]);
          if (args[2] === "subfolder") return { stdout: subfolder, stderr: "" };
          if (args[2] === "api_host") return { stdout: apiHost, stderr: "" };
          throw new Error(`Unexpected profile key: ${args[2]}`);
        }
        if (args.at(-1) === "projects/team%2Fapp/merge_requests/1") {
          return httpJson({ iid: 1, state: "opened", web_url: url, sha: "intended-project" });
        }
        if (args.at(-1)?.startsWith("projects/team%2Fapp/merge_requests/1/discussions?")) {
          return httpJson([]);
        }
        return httpJson({ message: "404 Project Not Found" }, {}, "404 Not Found");
      });
      const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
      const snapshots: ChangeRequestSnapshot[] = [];
      const errors: unknown[] = [];
      try {
        service.changeRequests!.observe(url, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error: (error) => errors.push(error),
        });
        await vi.advanceTimersByTimeAsync(25);
        expect(errors).toEqual([]);
        expect(snapshots).toEqual([expect.objectContaining({ headSha: "intended-project" })]);
      } finally {
        service.dispose?.();
      }
    },
  );

  it("rejects a different GitLab project on the same origin", async () => {
    vi.useFakeTimers();
    const { runner, calls } = createFakeGlabRunner((args) => {
      if (args[0] === "auth" || args[0] === "config") return { stdout: "", stderr: "" };
      return httpJson({
        iid: 1,
        state: "merged",
        sha: "other-project-head",
        web_url: "https://gitlab.example.org/gitlab/gitlab/team/app/-/merge_requests/1",
      });
    });
    const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(
        "https://gitlab.example.org/gitlab/team/app/-/merge_requests/1",
        {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error: (error) => errors.push(error),
        },
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining("different project") }),
      ]);
      expect(snapshots).toEqual([]);
      expect(calls.filter(({ args }) => args[0] === "api")).toHaveLength(1);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["500 Internal Server Error", "429 Too Many Requests"])(
    "reports the merge and new notes if approval enrichment returns %s",
    async (status) => {
      vi.useFakeTimers();
      const url = "https://gitlab.com/team/app/-/merge_requests/1";
      let polls = 0;
      const { runner, calls } = createFakeGlabRunner((args) => {
        const endpoint = args.at(-1)!;
        if (endpoint.endsWith("/merge_requests/1")) {
          polls += 1;
          return httpJson({
            iid: 1,
            state: polls === 1 ? "opened" : "merged",
            sha: "head",
            web_url: url,
          });
        }
        if (endpoint.includes("/discussions?")) {
          return httpJson(
            polls === 1
              ? []
              : [
                  {
                    id: "d",
                    notes: [
                      { id: 10, body: "Done" },
                      {
                        id: 11,
                        system: true,
                        body: "approved this merge request",
                        author: { username: "alice" },
                      },
                    ],
                  },
                ],
          );
        }
        if (endpoint.endsWith("/approvals")) {
          return httpJson({ message: status }, { "Retry-After": "60" }, status);
        }
        throw new Error(`Unexpected GitLab endpoint: ${endpoint}`);
      });
      const service = createGitLabService({
        runner,
        resolveGlabPath: async () => "glab",
        watchPollMs: 10_000,
      });
      const snapshots: ChangeRequestSnapshot[] = [];
      const errors: unknown[] = [];
      const observer = {
        knownActivity: () => new Set<string>(),
        async snapshot(snapshot: ChangeRequestSnapshot) {
          snapshots.push(snapshot);
        },
        error: (error: unknown) => errors.push(error),
      };
      try {
        const release = service.changeRequests!.observe(url, observer);
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(errors).toEqual([]);
        expect(snapshots.at(-1)).toMatchObject({
          state: "merged",
          activity: [
            { id: "comment:10", kind: "comment" },
            {
              id: "approval-note:11",
              kind: "approval",
              message: `Merge request approved by @alice: ${url}#note_11`,
            },
          ],
        });
        release();
        if (status.startsWith("429")) {
          service.changeRequests!.observe(url, observer);
          await vi.advanceTimersByTimeAsync(59_999);
          expect(
            calls.filter(({ args }) => args.at(-1)?.endsWith("/merge_requests/1")),
          ).toHaveLength(2);
          await vi.advanceTimersByTimeAsync(1);
          expect(
            calls.filter(({ args }) => args.at(-1)?.endsWith("/merge_requests/1")),
          ).toHaveLength(3);
        }
      } finally {
        service.dispose?.();
      }
    },
  );

  it("rejects a merge request served by a different GitLab web origin", async () => {
    vi.useFakeTimers();
    const { runner, calls } = createFakeGlabRunner((args) => {
      if (args[0] === "auth" || args[0] === "config") return { stdout: "", stderr: "" };
      return httpJson({
        iid: 1,
        state: "merged",
        sha: "other-head",
        web_url: "https://gitlab.example.org:3443/team/app/-/merge_requests/1",
      });
    });
    const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(
        "https://gitlab.example.org:9443/team/app/-/merge_requests/1",
        {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error: (error) => errors.push(error),
        },
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining("web origin") }),
      ]);
      expect(snapshots).toEqual([]);
      expect(calls.filter(({ args }) => args[0] === "api")).toHaveLength(1);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["403 Forbidden", "404 Not Found"])(
    "publishes a merge and its discussion when pipeline jobs return %s",
    async (deniedStatus) => {
      vi.useFakeTimers();
      const url = "https://gitlab.com/team/app/-/merge_requests/1";
      let polls = 0;
      const { runner } = createFakeGlabRunner((args) => {
        const endpoint = args.at(-1)!;
        if (endpoint === "projects/team%2Fapp/merge_requests/1") {
          polls += 1;
          return httpJson({
            iid: 1,
            state: polls === 1 ? "opened" : "merged",
            sha: "head",
            web_url: url,
            head_pipeline: { id: 3, status: polls === 1 ? "running" : "failed" },
          });
        }
        if (endpoint.includes("/jobs?")) {
          return polls === 1
            ? httpJson([{ id: 4, name: "test", status: "running" }])
            : httpJson({ message: deniedStatus }, {}, deniedStatus);
        }
        if (endpoint.includes("/discussions?")) {
          return httpJson(polls === 1 ? [] : [{ id: "d", notes: [{ id: 7, body: "Done" }] }]);
        }
        throw new Error(`Unexpected GitLab endpoint: ${endpoint}`);
      });
      const service = createGitLabService({
        runner,
        resolveGlabPath: async () => "glab",
        watchPollMs: 10_000,
      });
      const snapshots: ChangeRequestSnapshot[] = [];
      const errors: unknown[] = [];
      try {
        service.changeRequests!.observe(url, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error: (error) => errors.push(error),
        });
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(errors).toEqual([]);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[1]).toMatchObject({
          state: "merged",
          checksState: "failed",
          checks: [{ id: "pipeline:3", name: "Pipeline #3", state: "failed" }],
          activity: [{ id: "comment:7", kind: "comment", url: `${url}#note_7` }],
        });
      } finally {
        service.dispose?.();
      }
    },
  );

  it("reads merge updates when GitLab's authentication status endpoint is down", async () => {
    vi.useFakeTimers();
    const url = "https://gitlab.example.org/team/app/-/merge_requests/1";
    let merged = false;
    const { runner, calls } = createFakeGlabRunner((args) => {
      if (args[0] === "auth") {
        if (merged) throw new Error("GitLab /user returned 403");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "config") return { stdout: "", stderr: "" };
      if (args.at(-1)?.includes("/discussions?")) return httpJson([]);
      return httpJson({ iid: 1, state: merged ? "merged" : "opened", sha: "head", web_url: url });
    });
    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(url, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(25);
      merged = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toEqual([]);
      expect(snapshots.map(({ state }) => state)).toEqual(["open", "merged"]);
      expect(calls.filter(({ args }) => args[0] === "auth")).toEqual([]);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["401 Unauthorized", "403 Forbidden", "404 Not Found"])(
    "uses a valid bare profile after the port profile returns %s",
    async (denial) => {
      vi.useFakeTimers();
      const host = "gitlab.example.org";
      const authority = `${host}:3443`;
      const url = `https://${authority}/team/app/-/merge_requests/1`;
      const { runner, calls } = createFakeGlabRunner((args, options) => {
        if (args[0] === "config") {
          return { stdout: args[2] === "api_host" ? authority : "", stderr: "" };
        }
        if (options.envOverlay?.GITLAB_HOST === authority) {
          return httpJson({ message: denial }, {}, denial);
        }
        if (args.at(-1)?.includes("/discussions?")) return httpJson([]);
        return httpJson({ iid: 1, state: "opened", sha: "valid-profile", web_url: url });
      });
      const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
      const snapshots: ChangeRequestSnapshot[] = [];
      const errors: unknown[] = [];
      try {
        service.changeRequests!.observe(url, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error: (error) => errors.push(error),
        });
        await vi.advanceTimersByTimeAsync(25);
        expect(errors).toEqual([]);
        expect(snapshots[0]?.headSha).toBe("valid-profile");
        expect(
          calls
            .filter(({ args }) => args[0] === "api")
            .map(({ envOverlay }) => envOverlay?.GITLAB_HOST),
        ).toEqual([authority, host, host]);
      } finally {
        service.dispose?.();
      }
    },
  );

  it("lets an admitted poll finish when the MR read leaves one request", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    const url = "https://gitlab.com/team/app/-/merge_requests/1";
    const { runner, calls } = createFakeGlabRunner((args) => {
      if (args.at(-1)?.includes("/discussions?")) return httpJson([]);
      return httpJson(
        { iid: 1, state: "opened", sha: "head", web_url: url },
        { "RateLimit-Remaining": "1", "RateLimit-Reset": String(now / 1000 + 90) },
      );
    });
    const service = createGitLabService({
      runner,
      resolveGlabPath: async () => "glab",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(url, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([]);
      expect(snapshots).toHaveLength(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(89_974);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(4);
    } finally {
      service.dispose?.();
    }
  });

  it.each([2, 3])("lets each watch finish across quota windows with %i requests", async (quota) => {
    vi.useFakeTimers();
    const start = 1_700_000_000_000;
    vi.setSystemTime(start);
    const url = "https://gitlab.com/team/app/-/merge_requests";
    let window = -1;
    let requests = 0;
    const { runner } = createFakeGlabRunner((args) => {
      const currentWindow = Math.floor((Date.now() - start) / 60_000);
      if (window !== currentWindow) {
        window = currentWindow;
        requests = 0;
      }
      requests += 1;
      if (requests > quota) {
        return httpJson({}, { "Retry-After": "60" }, "429 Too Many Requests");
      }
      const endpoint = args.at(-1)!;
      if (endpoint.includes("/discussions?")) return httpJson([]);
      const iid = Number(endpoint.at(-1));
      return httpJson({
        iid,
        state: iid === 2 ? "merged" : "opened",
        sha: "head",
        web_url: `${url}/${iid}`,
      });
    });
    const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
    const snapshots: string[] = [];
    const failures: number[] = [];
    try {
      for (const iid of [1, 2]) {
        service.changeRequests!.observe(`${url}/${iid}`, {
          async snapshot(snapshot) {
            snapshots.push(`${iid}:${snapshot.state}`);
          },
          error() {
            failures.push(iid);
          },
        });
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toEqual(quota === 3 ? ["1:open"] : []);
      expect(failures).toEqual(quota === 3 ? [2] : [1, 2]);
      await vi.advanceTimersByTimeAsync(quota === 3 ? 60_000 : 120_000);
      expect(snapshots).toEqual(["1:open", "2:merged"]);
    } finally {
      service.dispose?.();
    }
  });

  it("stops an overlapping poll before it starts another GitLab API request during a pause", async () => {
    vi.useFakeTimers();
    const url = "https://gitlab.com/team/app/-/merge_requests";
    let releaseMr!: () => void;
    const firstMr = new Promise<void>((resolve) => {
      releaseMr = resolve;
    });
    const { runner, calls } = createFakeGlabRunner(async (args) => {
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/merge_requests/1")) {
        await firstMr;
        return httpJson({ iid: 1, state: "opened", sha: "head", web_url: `${url}/1` });
      }
      if (endpoint.endsWith("/merge_requests/2")) {
        return httpJson({}, { "Retry-After": "90" }, "429 Too Many Requests");
      }
      return httpJson([]);
    });
    const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    const observer = {
      async snapshot(snapshot: ChangeRequestSnapshot) {
        snapshots.push(snapshot);
      },
      error: (error: unknown) => errors.push(error),
    };
    try {
      service.changeRequests!.observe(`${url}/1`, observer);
      service.changeRequests!.observe(`${url}/2`, observer);
      await vi.advanceTimersByTimeAsync(25);
      releaseMr();
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(2);
      expect(snapshots).toEqual([]);
      expect(calls.map(({ args }) => args.at(-1))).toEqual([
        "projects/team%2Fapp/merge_requests/1",
        "projects/team%2Fapp/merge_requests/2",
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("rereads the profile's subfolder when the installer changes it", async () => {
    vi.useFakeTimers();
    let folder = "gitlab";
    const mrUrl = () => `https://gitlab.example.org/${folder}/team/app/-/merge_requests/1`;
    const { runner } = createFakeGlabRunner((args) => {
      if (args[0] === "auth") return { stdout: "", stderr: "" };
      if (args[0] === "config")
        return { stdout: args[2] === "subfolder" ? folder : "", stderr: "" };
      const endpoint = args.at(-1)!;
      if (endpoint === "projects/team%2Fapp/merge_requests/1") {
        return httpJson({ iid: 1, state: "opened", web_url: mrUrl(), sha: folder });
      }
      if (endpoint.startsWith("projects/team%2Fapp/merge_requests/1/discussions?")) {
        return httpJson([]);
      }
      return httpJson({ message: "Project not found" }, {}, "404 Not Found");
    });
    const service = createGitLabService({ runner, resolveGlabPath: async () => "glab" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    const observer = {
      async snapshot(snapshot: ChangeRequestSnapshot) {
        snapshots.push(snapshot);
      },
      error: (error: unknown) => errors.push(error),
    };
    try {
      const release = service.changeRequests!.observe(mrUrl(), observer);
      await vi.advanceTimersByTimeAsync(25);
      release();
      folder = "new";
      service.changeRequests!.observe(mrUrl(), observer);
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([]);
      expect(snapshots.map(({ headSha }) => headSha)).toEqual(["gitlab", "new"]);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["bare", "bare with API host override", "port"])(
    "watches a custom-port instance with a %s CLI profile",
    async (profile) => {
      vi.useFakeTimers();
      const mrUrl = "https://gitlab.example.org:3443/team/app/-/merge_requests/1";
      const bare = "gitlab.example.org";
      const authority = `${bare}:3443`;
      const profileHost = profile === "port" ? authority : bare;
      const encoded = encodeURIComponent("team/app");
      const states = ["opened", "locked", "merged"] as const;
      let poll = 0;

      const { runner } = createFakeGlabRunner((args, options) => {
        if (args[0] === "config") {
          const override =
            profile === "bare with API host override" && options.envOverlay?.GITLAB_API_HOST !== "";
          const apiHost =
            args[2] === "api_host" && (override || args.at(-1) === profileHost) ? authority : "";
          return { stdout: apiHost, stderr: "" };
        }
        const expected =
          profile === "port" ? ["api", "-i"] : ["api", "--hostname", profileHost, "-i"];
        expect(args.slice(0, -1)).toEqual(expected);
        expect(options.envOverlay?.GITLAB_HOST).toBe(profileHost);
        const endpoint = args.at(-1) ?? "";
        if (endpoint === `projects/${encoded}/merge_requests/1`) {
          const state = states[Math.min(poll, states.length - 1)]!;
          poll += 1;
          return httpJson({
            iid: 1,
            state,
            merged_at: state === "merged" ? "2026-11-20T08:00:00Z" : null,
            sha: "sha-merge",
            web_url: mrUrl,
            head_pipeline: null,
          });
        }
        if (endpoint.includes("/discussions")) {
          return httpJson([], { "X-Next-Page": "" });
        }
        throw new Error(`Unexpected: ${args.join(" ")}`);
      });

      const service = createGitLabService({
        runner,
        resolveGlabPath: async () => "glab",
        watchPollMs: 10_000,
      });
      const probedHosts: string[] = [];
      const forgeResolver = createForgeResolver({
        probeForge: async (host) => {
          probedHosts.push(host);
          return host === profileHost ? "gitlab" : null;
        },
        createService: (forge) => (forge === "gitlab" ? service : null),
      });
      const router = createChangeRequestRouter({ forgeResolver });
      const snapshots: ChangeRequestSnapshot[] = [];
      try {
        const resolved = await router.resolve(`${mrUrl}/diffs`);
        expect(resolved).toEqual({ forge: "gitlab", url: mrUrl });
        expect(probedHosts).toEqual(profile === "port" ? [authority] : [authority, bare]);

        const release = router.source(resolved.forge)!.observe(resolved.url, {
          async snapshot(s) {
            snapshots.push(s);
          },
          error(err) {
            throw err;
          },
        });
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(snapshots.map((s) => s.state)).toEqual(["open", "open", "merged"]);
        release();
      } finally {
        forgeResolver.dispose();
      }
    },
  );
});
