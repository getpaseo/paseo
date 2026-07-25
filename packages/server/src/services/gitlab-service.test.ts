import { describe, expect, it } from "vitest";

import type { PullRequestCommandStatus } from "./forge-service.js";
import type { GitLabStatusFacts } from "./gitlab-facts.js";
import {
  type CreateGitLabServiceOptions,
  createGitLabService,
  GlabAuthenticationError,
  GlabCliMissingError,
  GlabCommandError,
  type GlabCommandResult,
  type GlabCommandRunner,
} from "./gitlab-service.js";

type Responder = (args: string[]) => GlabCommandResult | Promise<GlabCommandResult>;

function ok(stdout: string): GlabCommandResult {
  return { stdout, stderr: "" };
}

function makeService(responder: Responder, overrides: Partial<CreateGitLabServiceOptions> = {}) {
  const calls: string[][] = [];
  const runner: GlabCommandRunner = async (args) => {
    calls.push(args);
    return responder(args);
  };
  const service = createGitLabService({
    runner,
    resolveGlabPath: async () => "/usr/bin/glab",
    resolveRemoteUrl: async () => "git@gitlab.example.com:example-group/example-project.git",
    ...overrides,
  });
  return { service, calls };
}

function currentMrListArgs(headRef: string): string[] {
  return [
    "mr",
    "list",
    "--all",
    "--source-branch",
    headRef,
    "--order",
    "updated_at",
    "--sort",
    "desc",
    "--per-page",
    "100",
    "-F",
    "json",
  ];
}

function gitlabAutoMergeStatus(
  overrides: Partial<GitLabStatusFacts> = {},
): PullRequestCommandStatus {
  return {
    forgeSpecific: {
      forge: "gitlab",
      detailedMergeStatus: "ci_still_running",
      hasConflicts: false,
      blockingDiscussionsResolved: true,
      approvalsRequired: 0,
      approvalsGiven: 0,
      pipelineStatus: "running",
      pipelineId: 306,
      pipelineUrl: null,
      mergeWhenPipelineSucceeds: false,
      ...overrides,
    },
  };
}

const OPEN_MR = {
  iid: 14,
  title: "chore(release): 0.4.0",
  web_url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
  state: "opened",
  source_branch: "release/v0.4.0",
  target_branch: "main",
  sha: "1111111111111111111111111111111111111111",
  source_project_id: 101,
  target_project_id: 101,
  draft: false,
  work_in_progress: false,
  has_conflicts: false,
  merged_at: null,
  detailed_merge_status: "mergeable",
  description: "Release notes",
  labels: ["release"],
  updated_at: "2026-06-25T19:00:00.000Z",
  references: { full: "example-group/example-project!14", short: "!14" },
  head_pipeline: { status: "success" },
};

const OPEN_ISSUE = {
  iid: 7,
  title: "Login button misaligned",
  web_url: "https://gitlab.example.com/example-group/example-project/-/issues/7",
  state: "opened",
  description: "On mobile the login button overflows",
  labels: ["bug"],
  updated_at: "2026-06-24T08:00:00.000Z",
};

// Verbatim `glab issue list -O json` item (glab 1.105.0, gitlab.com). The list
// endpoint returns far more than the neutral mapping needs, and `web_url` points
// at `/-/work_items/<iid>`, not `/-/issues/<iid>`.
const REAL_GLAB_ISSUE = {
  id: 193324690,
  iid: 1,
  external_id: "",
  state: "opened",
  description: "Simple test",
  health_status: "",
  author: {
    id: 13341367,
    state: "active",
    web_url: "https://gitlab.com/example-user",
    name: "example-user",
    username: "example-user",
  },
  milestone: null,
  project_id: 83778606,
  assignees: [],
  updated_at: "2026-06-26T09:11:19.642Z",
  closed_at: null,
  title: "Test",
  created_at: "2026-06-26T09:11:19.642Z",
  labels: [],
  web_url: "https://gitlab.com/example-user/sample-repo/-/work_items/1",
  references: { short: "#1", relative: "#1", full: "example-user/sample-repo#1" },
  confidential: false,
  issue_type: "issue",
  user_notes_count: 0,
};

const NESTED_GROUP_MR = {
  ...OPEN_MR,
  iid: 73,
  web_url: "https://gitlab.example.com/example-group/nested/example-project/-/merge_requests/73",
  references: { full: "example-group/nested/example-project!73", short: "!73" },
};

const PIPELINE_WITH_JOBS = {
  id: 306,
  status: "failed",
  ref: "feat/sample-change",
  sha: "85e734528c160941f997703c63563d2587736a3e",
  web_url: "https://gitlab.example.com/example-group/example-project/-/pipelines/306",
  jobs: [
    {
      id: 929,
      name: "lint",
      stage: "test",
      status: "success",
      allow_failure: false,
      web_url: "https://gitlab.example.com/example-group/example-project/-/jobs/929",
      duration: 12.3,
    },
    {
      id: 931,
      name: "unit",
      stage: "test",
      status: "failed",
      allow_failure: false,
      web_url: "https://gitlab.example.com/example-group/example-project/-/jobs/931",
      duration: 38.2,
    },
    {
      id: 932,
      name: "flaky",
      stage: "test",
      status: "failed",
      allow_failure: true,
      web_url: "https://gitlab.example.com/example-group/example-project/-/jobs/932",
      duration: 5,
    },
    {
      id: 933,
      name: "deploy-prod",
      stage: "deploy",
      status: "skipped",
      allow_failure: false,
      web_url: "https://gitlab.example.com/example-group/example-project/-/jobs/933",
      duration: null,
    },
  ],
};

const APPROVALS = {
  approvals_required: 2,
  approvals_left: 1,
  approved_by: [{ user: { username: "reviewer-a" } }],
};

// Mirrors `glab api projects/:id/merge_requests/:iid/discussions` (GitLab 16+).
const DISCUSSIONS = [
  {
    id: "sys-1",
    individual_note: true,
    notes: [
      {
        id: 399,
        type: null,
        system: true,
        body: "enabled an automatic merge",
        created_at: "2026-06-25T19:24:04.180Z",
        author: { username: "claude", name: "Claude", web_url: "https://gl/claude" },
      },
    ],
  },
  {
    id: "note-1",
    individual_note: true,
    notes: [
      {
        id: 401,
        type: null,
        system: false,
        body: "Looks good to me",
        created_at: "2026-06-25T20:00:00.000Z",
        author: {
          username: "reviewer-a",
          name: "Reviewer A",
          web_url: "https://gl/reviewer-a",
          avatar_url: "https://gl/avatar-a.png",
        },
      },
    ],
  },
  {
    id: "thread-1",
    individual_note: false,
    notes: [
      {
        id: 402,
        type: "DiffNote",
        system: false,
        body: "This line needs a guard",
        created_at: "2026-06-25T19:55:00.000Z",
        resolvable: true,
        resolved: false,
        author: { username: "reviewer-b", web_url: "https://gl/reviewer-b" },
        position: { new_path: "src/app.ts", old_path: "src/app.ts", new_line: 42, old_line: null },
      },
    ],
  },
];

describe("createGitLabService", () => {
  it("maps a glab merge request view to the neutral current PR status", async () => {
    const { service, calls } = makeService((args) =>
      ok(JSON.stringify(args[1] === "list" ? [OPEN_MR] : OPEN_MR)),
    );

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "release/v0.4.0",
    });

    expect(status).toMatchObject({
      number: 14,
      url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
      title: "chore(release): 0.4.0",
      state: "open",
      baseRefName: "main",
      headRefName: "release/v0.4.0",
      isMerged: false,
      isDraft: false,
      mergeable: "MERGEABLE",
      checksStatus: "success",
      reviewDecision: null,
      repoOwner: "example-group",
      repoName: "example-project",
      projectPath: "example-group/example-project",
    });
    expect(status?.forgeSpecific).toMatchObject({
      forge: "gitlab",
      detailedMergeStatus: "mergeable",
      hasConflicts: false,
      pipelineStatus: "success",
      mergeWhenPipelineSucceeds: false,
    });
    expect(calls[0]).toEqual(currentMrListArgs("release/v0.4.0"));
    expect(calls[1]).toEqual(["mr", "view", "14", "-F", "json"]);
  });

  it("reports a conflicting merge request as CONFLICTING", async () => {
    const conflicting = {
      ...OPEN_MR,
      source_branch: "x",
      has_conflicts: true,
      detailed_merge_status: "broken_status",
    };
    const { service } = makeService((args) =>
      ok(JSON.stringify(args[1] === "list" ? [conflicting] : conflicting)),
    );
    const status = await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "x" });
    expect(status?.mergeable).toBe("CONFLICTING");
  });

  it("returns null when no merge request exists for the branch", async () => {
    const { service } = makeService(() => ok("[]"));
    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/x",
    });
    expect(status).toBeNull();
  });

  it("selects a terminal merge request only when its head SHA matches the checkout", async () => {
    const branch = "dev";
    const checkoutSha = "2222222222222222222222222222222222222222";
    const newestStale = {
      ...OPEN_MR,
      iid: 271,
      state: "merged",
      source_branch: branch,
      sha: "1111111111111111111111111111111111111111",
      updated_at: "2026-07-17T12:00:00.000Z",
    };
    const exactOlder = {
      ...OPEN_MR,
      iid: 270,
      state: "merged",
      source_branch: branch,
      sha: checkoutSha,
      updated_at: "2026-07-16T12:00:00.000Z",
    };
    const { service, calls } = makeService((args) => {
      if (args[1] === "list") return ok(JSON.stringify([newestStale, exactOlder]));
      if (args[1] === "view" && args[2] === "270") return ok(JSON.stringify(exactOlder));
      if (args[0] === "api") return ok("{}");
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: branch,
      headSha: checkoutSha,
    });

    expect(status?.number).toBe(270);
    expect(calls[1]).toEqual(["mr", "view", "270", "-F", "json"]);
  });

  it("does not attach the latest historical merge request after a reused branch advances", async () => {
    const stale = {
      ...OPEN_MR,
      state: "merged",
      source_branch: "dev",
      sha: "1111111111111111111111111111111111111111",
    };
    const { service, calls } = makeService(() => ok(JSON.stringify([stale])));

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "dev",
        headSha: "2222222222222222222222222222222222222222",
      }),
    ).resolves.toBeNull();
    expect(calls).toEqual([currentMrListArgs("dev")]);
  });

  it("looks up a numeric current branch through the source-branch list filter", async () => {
    const numericBranchMr = {
      ...OPEN_MR,
      iid: 21,
      source_branch: "1234",
      title: "Fix numeric branch",
      web_url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/21",
      references: { full: "example-group/example-project!21", short: "!21" },
    };
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "list") {
        return ok(JSON.stringify([numericBranchMr]));
      }
      if (args[0] === "mr" && args[1] === "view" && args[2] === "21") {
        return ok(JSON.stringify(numericBranchMr));
      }
      if (args[0] === "mr" && args[1] === "view" && args[2] === "1234") {
        throw new Error("numeric branch must not be viewed as an iid");
      }
      if (args[0] === "api" && args[1].endsWith("/approvals")) {
        return ok("{}");
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "1234",
      headSha: "2222222222222222222222222222222222222222",
    });

    expect(status).toMatchObject({
      number: 21,
      title: "Fix numeric branch",
      headRefName: "1234",
    });
    expect(calls[0]).toEqual(currentMrListArgs("1234"));
    expect(calls[1]).toEqual(["mr", "view", "21", "-F", "json"]);
    expect(calls).not.toContainEqual(["mr", "view", "1234", "-F", "json"]);
  });

  it("returns null when a numeric current branch has no open merge request", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "list") {
        return ok("[]");
      }
      if (args[0] === "mr" && args[1] === "view" && args[2] === "1234") {
        throw new Error("numeric branch must not be viewed as an iid");
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "1234",
    });

    expect(status).toBeNull();
    expect(calls).toEqual([currentMrListArgs("1234")]);
  });

  it("lists merge requests as neutral PR summaries", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_MR])));
    const list = await service.listPullRequests({ cwd: "/repo", limit: 5 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 14, title: "chore(release): 0.4.0", state: "open" });
    expect(calls[0]).toEqual(["mr", "list", "-F", "json", "-P", "5"]);
  });

  it("resolves the glab CLI path once per service instance, not per invocation", async () => {
    let resolveCalls = 0;
    const { service } = makeService(() => ok(JSON.stringify([OPEN_MR])), {
      resolveGlabPath: async () => {
        resolveCalls += 1;
        return "/usr/bin/glab";
      },
    });

    await service.listPullRequests({ cwd: "/repo", limit: 5 });
    await service.listPullRequests({ cwd: "/repo", limit: 5 });

    expect(resolveCalls).toBe(1);
  });

  it("maps a same-repo merge request view to a checkout target", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify(OPEN_MR)));

    await expect(
      service.getPullRequestCheckoutTarget?.({ cwd: "/repo", number: 14 }),
    ).resolves.toEqual({
      number: 14,
      baseRefName: "main",
      headRefName: "release/v0.4.0",
      checkoutRefs: [
        { remoteName: "origin", remoteRef: "refs/merge-requests/14/head" },
        { remoteName: "origin", remoteRef: "refs/heads/release/v0.4.0" },
      ],
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    });
    expect(calls[0]).toEqual(["mr", "view", "14", "-F", "json"]);
  });

  it("marks fork merge request checkout targets as cross-repository", async () => {
    const { service } = makeService(() =>
      ok(
        JSON.stringify({
          ...OPEN_MR,
          source_project_id: 202,
          target_project_id: 101,
        }),
      ),
    );

    await expect(
      service.getPullRequestCheckoutTarget?.({ cwd: "/repo", number: 14 }),
    ).resolves.toMatchObject({
      number: 14,
      headRefName: "release/v0.4.0",
      isCrossRepository: true,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
    });
  });

  it("creates a merge request and parses the URL and iid from glab output", async () => {
    const { service, calls } = makeService(() =>
      ok(
        "Creating merge request for release/v0.4.0 into main\n" +
          "https://gitlab.example.com/example-group/example-project/-/merge_requests/15\n",
      ),
    );
    const result = await service.createPullRequest({
      cwd: "/repo",
      repo: "example-group/example-project",
      title: "Ship it",
      head: "release/v0.4.0",
      base: "main",
      body: "Body",
    });
    expect(result).toEqual({
      url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/15",
      number: 15,
    });
    expect(calls[0]).toEqual([
      "mr",
      "create",
      "--title",
      "Ship it",
      "--description",
      "Body",
      "--source-branch",
      "release/v0.4.0",
      "--target-branch",
      "main",
      "--yes",
    ]);
  });

  it("merges with the requested strategy when GitLab reports the MR as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));
    const result = await service.mergePullRequest({
      cwd: "/repo",
      prNumber: 14,
      mergeMethod: "squash",
      status: {
        forgeSpecific: {
          forge: "gitlab",
          detailedMergeStatus: "mergeable",
          hasConflicts: false,
          blockingDiscussionsResolved: true,
          approvalsRequired: 0,
          approvalsGiven: 0,
          pipelineStatus: "success",
          pipelineId: null,
          pipelineUrl: null,
          mergeWhenPipelineSucceeds: false,
        },
      },
    });
    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual(["mr", "merge", "14", "--auto-merge=false", "--yes", "--squash"]);
  });

  it("refuses a direct merge when GitLab does not report the MR as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));
    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 14,
        mergeMethod: "merge",
        status: {
          forgeSpecific: {
            forge: "gitlab",
            detailedMergeStatus: "ci_still_running",
            hasConflicts: false,
            blockingDiscussionsResolved: true,
            approvalsRequired: 0,
            approvalsGiven: 0,
            pipelineStatus: "running",
            pipelineId: null,
            pipelineUrl: null,
            mergeWhenPipelineSucceeds: false,
          },
        },
      }),
    ).rejects.toThrow(/ready for direct merge/);
    expect(calls).toHaveLength(0);
  });

  it("enables auto-merge by scheduling merge when the pipeline succeeds", async () => {
    const { service, calls } = makeService(() => ok(""));
    const result = await service.enablePullRequestAutoMerge({
      cwd: "/repo",
      prNumber: 14,
      mergeMethod: "squash",
      status: gitlabAutoMergeStatus(),
    });
    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual(["mr", "merge", "14", "--auto-merge", "--yes", "--squash"]);
  });

  it("enables auto-merge without a strategy flag for the plain merge method", async () => {
    const { service, calls } = makeService(() => ok(""));
    await service.enablePullRequestAutoMerge({
      cwd: "/repo",
      prNumber: 14,
      mergeMethod: "merge",
      status: gitlabAutoMergeStatus(),
    });
    expect(calls[0]).toEqual(["mr", "merge", "14", "--auto-merge", "--yes"]);
  });

  it("refuses to enable auto-merge without an active pipeline because it would merge immediately", async () => {
    const { service, calls } = makeService(() => ok(""));
    await expect(
      service.enablePullRequestAutoMerge({
        cwd: "/repo",
        prNumber: 14,
        mergeMethod: "squash",
        status: gitlabAutoMergeStatus({ pipelineStatus: "success" }),
      }),
    ).rejects.toThrow(/in-progress pipeline/);
    expect(calls).toHaveLength(0);
  });

  it("disables auto-merge by cancelling the scheduled merge via the API", async () => {
    const { service, calls } = makeService(() => ok(""));
    const result = await service.disablePullRequestAutoMerge({
      cwd: "/repo",
      prNumber: 14,
    });
    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "POST",
      "projects/:fullpath/merge_requests/14/cancel_merge_when_pipeline_succeeds",
    ]);
  });

  it("surfaces the head pipeline id and url on the gitlab status facts", async () => {
    const pipelineMr = {
      ...OPEN_MR,
      head_pipeline: {
        id: 306,
        status: "running",
        web_url: "https://gitlab.example.com/example-group/example-project/-/pipelines/306",
      },
    };
    const { service } = makeService((args) =>
      ok(JSON.stringify(args[1] === "list" ? [pipelineMr] : pipelineMr)),
    );

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "release/v0.4.0",
    });

    expect(status?.checksStatus).toBe("pending");
    expect(status?.forgeSpecific).toMatchObject({
      forge: "gitlab",
      pipelineStatus: "running",
      pipelineId: 306,
      pipelineUrl: "https://gitlab.example.com/example-group/example-project/-/pipelines/306",
    });
  });

  it("fetches a pipeline's stages and jobs as neutral check details", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify(PIPELINE_WITH_JOBS)));

    const details = await service.getCheckDetails({
      cwd: "/repo",
      checkRunId: 306,
    });

    expect(calls[0]).toEqual([
      "ci",
      "get",
      "--pipeline-id",
      "306",
      "--with-job-details",
      "-F",
      "json",
    ]);
    expect(details).toMatchObject({
      checkRunId: 306,
      name: "Pipeline (feat/sample-change)",
      failedJobs: [],
      annotations: [],
      truncated: false,
    });
    expect(details.pipeline).toMatchObject({
      id: 306,
      status: "failed",
      rawStatus: "failed",
      ref: "feat/sample-change",
      stages: [
        {
          name: "test",
          status: "failed",
          jobs: [
            { id: 929, name: "lint" },
            {
              id: 931,
              name: "unit",
              status: "failed",
              allowFailure: false,
              durationSeconds: 38.2,
            },
            { id: 932, name: "flaky", status: "failed", allowFailure: true },
          ],
        },
        {
          name: "deploy",
          status: "skipped",
          jobs: [{ id: 933, name: "deploy-prod", durationSeconds: null }],
        },
      ],
    });
  });

  it("addresses the change request's head pipeline by iid (fork/detached safe)", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify(PIPELINE_WITH_JOBS)));

    await service.getCheckDetails({
      cwd: "/repo",
      checkRunId: 306,
      changeRequestNumber: 14,
    });

    expect(calls[0]).toEqual([
      "ci",
      "get",
      "--merge-request",
      "14",
      "--with-job-details",
      "-F",
      "json",
    ]);
  });

  it("does not fail a stage when only allow_failure jobs failed", async () => {
    const { service } = makeService(() =>
      ok(
        JSON.stringify({
          ...PIPELINE_WITH_JOBS,
          status: "success",
          jobs: [
            {
              id: 940,
              name: "lint",
              stage: "test",
              status: "success",
              allow_failure: false,
            },
            {
              id: 941,
              name: "optional",
              stage: "test",
              status: "failed",
              allow_failure: true,
            },
          ],
        }),
      ),
    );

    const details = await service.getCheckDetails({ cwd: "/repo", checkRunId: 306 });
    expect(details.pipeline?.stages[0]?.status).toBe("success");
  });

  it("populates approval counts from the approvals endpoint", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "list") return ok(JSON.stringify([OPEN_MR]));
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
      if (args[0] === "api" && args[1].endsWith("/approvals")) return ok(JSON.stringify(APPROVALS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "release/v0.4.0",
    });

    expect(status?.forgeSpecific).toMatchObject({
      forge: "gitlab",
      approvalsRequired: 2,
      approvalsGiven: 1,
    });
    expect(calls[2]).toEqual([
      "api",
      "projects/example-group%2Fexample-project/merge_requests/14/approvals",
    ]);
  });

  it("falls back to zero approvals when the approvals endpoint returns an error", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "list") return ok(JSON.stringify([OPEN_MR]));
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
      throw { code: 1, stderr: "500 Internal Server Error" };
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "release/v0.4.0",
    });

    expect(status?.number).toBe(14);
    expect(status?.forgeSpecific).toMatchObject({
      forge: "gitlab",
      approvalsRequired: 0,
      approvalsGiven: 0,
    });
  });

  it("maps MR discussions to a neutral timeline, dropping system notes", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(NESTED_GROUP_MR));
      if (args[0] === "api" && args[1].includes("/discussions"))
        return ok(JSON.stringify(DISCUSSIONS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    expect(calls[1]).toEqual([
      "api",
      "projects/example-group%2Fnested%2Fexample-project/merge_requests/73/discussions?per_page=100",
    ]);
    expect(timeline.error).toBeNull();
    expect(timeline.truncated).toBe(false);
    // System note 399 is dropped; the diff note (19:55) sorts before the comment (20:00).
    expect(timeline.items.map((item) => item.id)).toEqual(["402", "401"]);

    const [diffNote, comment] = timeline.items;
    expect(diffNote).toMatchObject({
      kind: "comment",
      id: "402",
      author: "reviewer-b",
      url: "https://gitlab.example.com/example-group/nested/example-project/-/merge_requests/73#note_402",
      location: { path: "src/app.ts", line: 42, threadId: "thread-1", isResolved: false },
    });
    expect(comment).toMatchObject({
      kind: "comment",
      id: "401",
      author: "reviewer-a",
      authorUrl: "https://gl/reviewer-a",
      avatarUrl: "https://gl/avatar-a.png",
      body: "Looks good to me",
    });
    expect(comment).not.toHaveProperty("location");
  });

  it("groups general (non-file) discussion replies under one top-level thread id", async () => {
    const discussions = [
      {
        id: "disc-general",
        individual_note: false,
        notes: [
          {
            id: 501,
            system: false,
            body: "Can you clarify the rollout plan?",
            created_at: "2026-06-25T20:00:00.000Z",
            author: { username: "reviewer-a" },
          },
          {
            id: 502,
            system: false,
            body: "Sure, staged behind a flag.",
            created_at: "2026-06-25T20:05:00.000Z",
            author: { username: "author-b" },
          },
        ],
      },
      {
        id: "disc-standalone",
        individual_note: true,
        notes: [
          {
            id: 503,
            system: false,
            body: "Nice work overall.",
            created_at: "2026-06-25T20:10:00.000Z",
            author: { username: "reviewer-c" },
          },
        ],
      },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(NESTED_GROUP_MR));
      if (args[0] === "api" && args[1].includes("/discussions"))
        return ok(JSON.stringify(discussions));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    const byId = new Map(timeline.items.map((item) => [item.id, item]));
    expect(byId.get("501")).toMatchObject({ kind: "comment", threadId: "disc-general" });
    expect(byId.get("502")).toMatchObject({ kind: "comment", threadId: "disc-general" });
    expect(byId.get("501")).not.toHaveProperty("location");
    // A standalone (individual) note must not be turned into a thread.
    expect(byId.get("503")).not.toHaveProperty("threadId");
  });

  it("maps general resolvable discussion resolution to threadIsResolved", async () => {
    const discussions = [
      {
        id: "disc-unresolved",
        individual_note: false,
        notes: [
          {
            id: 511,
            system: false,
            body: "Still open question.",
            created_at: "2026-06-25T20:00:00.000Z",
            author: { username: "reviewer-a" },
            resolvable: true,
            resolved: false,
          },
        ],
      },
      {
        id: "disc-resolved",
        individual_note: false,
        notes: [
          {
            id: 512,
            system: false,
            body: "Addressed, thanks.",
            created_at: "2026-06-25T20:05:00.000Z",
            author: { username: "author-b" },
            resolvable: true,
            resolved: true,
          },
        ],
      },
      {
        id: "disc-plain",
        individual_note: true,
        notes: [
          {
            id: 513,
            system: false,
            body: "Just a plain comment.",
            created_at: "2026-06-25T20:10:00.000Z",
            author: { username: "reviewer-c" },
          },
        ],
      },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(NESTED_GROUP_MR));
      if (args[0] === "api" && args[1].includes("/discussions"))
        return ok(JSON.stringify(discussions));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    const byId = new Map(timeline.items.map((item) => [item.id, item]));
    expect(byId.get("511")).toMatchObject({ threadIsResolved: false });
    expect(byId.get("512")).toMatchObject({ threadIsResolved: true });
    // A non-resolvable plain comment must not gain a resolution state.
    expect(byId.get("513")).not.toHaveProperty("threadIsResolved");
    // General discussions carry no file position, so no location either.
    expect(byId.get("511")).not.toHaveProperty("location");
  });

  it("maps a multiline diff range to startLine and omits resolution state for non-resolvable notes", async () => {
    const discussions = [
      {
        id: "disc-range",
        individual_note: false,
        notes: [
          {
            id: 601,
            system: false,
            body: "This block spans several lines.",
            created_at: "2026-06-25T21:00:00.000Z",
            author: { username: "reviewer-a" },
            position: {
              new_path: "src/app.ts",
              old_path: "src/app.ts",
              new_line: 48,
              old_line: null,
              line_range: {
                start: { new_line: 42, old_line: null },
                end: { new_line: 48, old_line: null },
              },
            },
          },
        ],
      },
      {
        id: "disc-plain",
        individual_note: true,
        notes: [
          {
            id: 602,
            system: false,
            body: "General comment without a resolvable flag.",
            created_at: "2026-06-25T21:05:00.000Z",
            author: { username: "reviewer-b" },
          },
        ],
      },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(NESTED_GROUP_MR));
      if (args[0] === "api" && args[1].includes("/discussions"))
        return ok(JSON.stringify(discussions));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    const rangeNote = timeline.items.find((item) => item.id === "601");
    expect(rangeNote).toMatchObject({
      kind: "comment",
      location: { path: "src/app.ts", line: 48, startLine: 42 },
    });
    expect(rangeNote && "location" in rangeNote ? rangeNote.location : null).not.toHaveProperty(
      "isResolved",
    );

    const plainNote = timeline.items.find((item) => item.id === "602");
    expect(plainNote).not.toHaveProperty("location");
  });

  it("returns a not_found timeline error when discussions cannot be fetched", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
      throw { code: 1, stderr: "404 Merge request not found" };
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    expect(timeline.items).toEqual([]);
    expect(timeline.error).toMatchObject({ kind: "not_found" });
  });

  it.each(["403 Forbidden", "401 Unauthorized"])(
    "returns a forbidden timeline error for %s",
    async (stderr) => {
      const { service } = makeService((args) => {
        if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
        throw { code: 1, stderr };
      });

      const timeline = await service.getPullRequestTimeline({
        cwd: "/repo",
        prNumber: 14,
        repoOwner: "example-group",
        repoName: "example-project",
      });

      expect(timeline).toMatchObject({
        items: [],
        truncated: false,
        error: { kind: "forbidden" },
      });
    },
  );

  it("flags truncation when a next-page probe finds more discussions", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `discussion-${index}`,
      notes: [],
    }));
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
      // The next-page probe asks for page 101; reply with one more discussion.
      if (args[1].includes("page=101")) return ok(JSON.stringify([{ id: "overflow", notes: [] }]));
      return ok(JSON.stringify(firstPage));
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    expect(calls.some((call) => call[1]?.includes("per_page=1&page=101"))).toBe(true);
    expect(timeline).toMatchObject({ items: [], truncated: true, error: null });
  });

  it("does not flag truncation when exactly one full page of discussions exists", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `discussion-${index}`,
      notes: [],
    }));
    const { service } = makeService((args) => {
      if (args[0] === "mr" && args[1] === "view") return ok(JSON.stringify(OPEN_MR));
      // The probe of page 101 comes back empty: there is no 101st discussion.
      if (args[1].includes("page=101")) return ok(JSON.stringify([]));
      return ok(JSON.stringify(firstPage));
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 14,
      repoOwner: "example-group",
      repoName: "example-project",
    });

    expect(timeline).toMatchObject({ truncated: false, error: null });
  });

  it("reports authentication via a host-scoped glab auth status", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "auth") return ok("");
      throw new Error("unexpected");
    });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(true);
    expect(calls[0]).toEqual(["auth", "status", "--hostname", "gitlab.example.com"]);
  });

  it("reports unauthenticated when glab auth status fails", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
  });

  it("reports unauthenticated when the cwd has no GitLab remote", async () => {
    const { service, calls } = makeService(() => ok(""), { resolveRemoteUrl: async () => null });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("throws GlabCliMissingError when glab is not installed", async () => {
    const { service } = makeService(() => ok("{}"), { resolveGlabPath: async () => null });
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCliMissingError,
    );
  });

  it("normalizes glab auth failures into GlabAuthenticationError", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "error: 401 Unauthorized — not logged in" };
    });
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabAuthenticationError,
    );
  });

  it("surfaces non-JSON glab stdout as a GlabCommandError", async () => {
    const { service } = makeService(() => ok("not json at all"));
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCommandError,
    );
  });

  it("surfaces schema-mismatched glab JSON as a GlabCommandError", async () => {
    const { service } = makeService(() => ok(JSON.stringify({ unexpected: true })));
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCommandError,
    );
  });

  it("searches issues and merge requests and maps them to neutral results", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([OPEN_ISSUE]));
      if (args[0] === "mr") return ok(JSON.stringify([OPEN_MR]));
      throw new Error(`unexpected glab args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "login", limit: 10 });

    expect(result.featuresEnabled).toBe(true);
    expect(result.authState).toBe("authenticated");
    expect(result.githubFeaturesEnabled).toBe(true);
    expect(result.items).toEqual([
      {
        kind: "change_request",
        number: 14,
        title: "chore(release): 0.4.0",
        url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
        state: "open",
        body: "Release notes",
        labels: ["release"],
        projectPath: "example-group/example-project",
        baseRefName: "main",
        headRefName: "release/v0.4.0",
        updatedAt: "2026-06-25T19:00:00.000Z",
      },
      {
        kind: "issue",
        number: 7,
        title: "Login button misaligned",
        url: "https://gitlab.example.com/example-group/example-project/-/issues/7",
        state: "opened",
        body: "On mobile the login button overflows",
        labels: ["bug"],
        baseRefName: null,
        headRefName: null,
        updatedAt: "2026-06-24T08:00:00.000Z",
      },
    ]);

    expect(calls.find((args) => args[0] === "mr")).toEqual([
      "mr",
      "list",
      "-F",
      "json",
      "--search",
      "login",
      "-P",
      "10",
    ]);
    expect(calls.find((args) => args[0] === "issue")).toEqual([
      "issue",
      "list",
      "-O",
      "json",
      "--search",
      "login",
      "-P",
      "10",
    ]);
  });

  it("parses the real glab issue list payload shape and uses the issue JSON flag", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([REAL_GLAB_ISSUE]));
      if (args[0] === "mr") return ok("[]");
      throw new Error(`unexpected glab args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "" });

    expect(result).toEqual({
      featuresEnabled: true,
      authState: "authenticated",
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "issue",
          number: 1,
          title: "Test",
          url: "https://gitlab.com/example-user/sample-repo/-/work_items/1",
          state: "opened",
          body: "Simple test",
          labels: [],
          projectPath: "example-user/sample-repo",
          baseRefName: null,
          headRefName: null,
          updatedAt: "2026-06-26T09:11:19.642Z",
        },
      ],
    });
    expect(calls.find((args) => args[0] === "issue")).toEqual(["issue", "list", "-O", "json"]);
  });

  it("restricts search to merge requests when only the PR kind is requested", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "mr") return ok(JSON.stringify([OPEN_MR]));
      throw new Error(`unexpected glab args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "release",
      kinds: ["github-pr"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "change_request", number: 14 });
    expect(calls).toEqual([["mr", "list", "-F", "json", "--search", "release"]]);
  });

  it("reports forge features disabled when glab is unavailable or unauthenticated", async () => {
    const missing = makeService(() => ok("[]"), { resolveGlabPath: async () => null }).service;
    await expect(missing.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual({
      items: [],
      featuresEnabled: false,
      authState: "cli_missing",
      githubFeaturesEnabled: false,
    });

    const unauthenticated = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    }).service;
    await expect(unauthenticated.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual(
      {
        items: [],
        featuresEnabled: false,
        authState: "unauthenticated",
        githubFeaturesEnabled: false,
      },
    );
  });

  it("rejects search when one requested kind fails for a non-auth reason", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "issue") {
        throw { code: 1, stderr: "temporary GitLab API failure" };
      }
      return ok(JSON.stringify([OPEN_MR]));
    });

    await expect(service.searchIssuesAndPrs({ cwd: "/repo", query: "release" })).rejects.toThrow(
      GlabCommandError,
    );
  });
});
